import dotenv from 'dotenv';
dotenv.config();

import { readFile } from 'fs/promises';
import { join } from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';
import { extractText, getDocumentProxy } from 'unpdf';
import { AutoTokenizer, AutoModel } from '@huggingface/transformers';
import type { PaperMeta, ChunkPayload } from './types.js';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const COLLECTION = process.env.QDRANT_COLLECTION ?? 'rag_papers';
const DATA_DIR = join(process.cwd(), 'data');
const PDFS_DIR = join(DATA_DIR, 'raw_pdfs');
const META_PATH = join(DATA_DIR, 'papers_meta.json');

const CHUNK_SIZE = 1200;
const OVERLAP = 200;
const BATCH_SIZE = 50;
const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
const VECTOR_SIZE = 384;

let tokenizer: any;
let model: any;

async function loadEmbedder(): Promise<void> {
  if (!tokenizer) {
    console.log(`Loading embedding model ${EMBED_MODEL} (may download weights on first run)...`);
    tokenizer = await AutoTokenizer.from_pretrained(EMBED_MODEL);
    model = await AutoModel.from_pretrained(EMBED_MODEL);
    console.log('Embedding model loaded.');
  }
}

function to2D(arr: any, rows: number): number[][] {
  if (Array.isArray(arr)) return arr as number[][];
  const dims = arr.dims ?? [rows, Math.floor(arr.length / rows)];
  const data = arr.data as number[];
  const cols = dims[1];
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    out.push(data.slice(r * cols, (r + 1) * cols));
  }
  return out;
}

function meanPool(lastHidden: Float32Array, dims: number[], mask: number[][]): number[][] {
  const [batch, seqLen, hidden] = dims;
  const results: number[][] = [];
  for (let b = 0; b < batch; b++) {
    const sum = new Array(hidden).fill(0);
    let count = 0;
    const base = b * seqLen * hidden;
    for (let s = 0; s < seqLen; s++) {
      if (mask[b]?.[s] === 1) {
        count++;
        for (let h = 0; h < hidden; h++) {
          sum[h] += lastHidden[base + s * hidden + h];
        }
      }
    }
    const vec: number[] = [];
    for (let h = 0; h < hidden; h++) {
      vec.push(count > 0 ? sum[h] / count : 0);
    }
    const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
    results.push(vec.map((v) => v / norm));
  }
  return results;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  await loadEmbedder();
  const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: 512 });
  const outputs = await model(inputs);
  const hidden = outputs.last_hidden_state as { data: Float32Array; dims: number[] };
  const mask = to2D(inputs.attention_mask, texts.length);
  return meanPool(hidden.data, hidden.dims, mask);
}

function chunkText(text: string, size = CHUNK_SIZE, overlap = OVERLAP): string[] {
  text = text.replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const sentenceEnd = text.lastIndexOf('. ', end);
      const newlineEnd = text.lastIndexOf('\n', end);
      const cut = Math.max(sentenceEnd, newlineEnd);
      if (cut > start && cut >= start + Math.floor(size * 0.5)) {
        end = cut + 1;
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= text.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
    if (start >= end) start = end;
  }
  return chunks;
}
async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === 'string' ? text : (text as string[]).join('\n');
}

export async function main(): Promise<void> {
  await loadEmbedder();
  const client = new QdrantClient({ url: QDRANT_URL });

  console.log(`Recreating Qdrant collection '${COLLECTION}' (size=${VECTOR_SIZE}, distance=Cosine)...`);
  await client.recreateCollection(COLLECTION, {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
  });

  const raw = await readFile(META_PATH, 'utf8');
  const papers: PaperMeta[] = JSON.parse(raw);

  let points: any[] = [];
  let pointId = 0;
  let pdfCount = 0;
  let abstractCount = 0;
  let totalChunks = 0;

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    const pdfPath = join(PDFS_DIR, `${paper.id}.pdf`);
    let text = '';
    let sourceType: ChunkPayload['source_type'] = 'abstract';

    try {
      const stat = await readFile(pdfPath).then(() => true, () => false);
      if (stat) {
        text = await extractPdfText(pdfPath);
        sourceType = 'pdf';
        pdfCount++;
      }
    } catch {
      // fall through to abstract fallback
    }

    if (!text) {
      text = `${paper.title}. ${paper.abstract}`;
      sourceType = 'abstract';
      abstractCount++;
    }

    const chunks = chunkText(text);
    const embeddings = await embedTexts(chunks);

    for (let ci = 0; ci < chunks.length; ci++) {
      points.push({
        id: pointId++,
        vector: embeddings[ci],
        payload: {
          paper_id: paper.id,
          title: paper.title,
          year: paper.year,
          chunk_index: ci,
          source_type: sourceType,
          text: chunks[ci],
        } as ChunkPayload,
      });
      totalChunks++;
      if (points.length >= BATCH_SIZE) {
        await client.upsert(COLLECTION, { wait: true, points });
        points = [];
      }
    }

    console.log(
      `  [${i + 1}/${papers.length}] ${paper.id} -> ${chunks.length} chunks (${sourceType}) | ${paper.title.slice(0, 70)}`,
    );
  }

  if (points.length > 0) {
    await client.upsert(COLLECTION, { wait: true, points });
  }

  const info: any = await client.getCollection(COLLECTION);
  const pointsCount = info?.points_count ?? info?.indexed_vectors_count ?? 'unknown';

  console.log(`\nIndexing complete.`);
  console.log(`  Papers processed: ${papers.length}`);
  console.log(`  PDF text extracted: ${pdfCount}`);
  console.log(`  Abstract fallbacks: ${abstractCount}`);
  console.log(`  Total chunks indexed: ${totalChunks}`);
  console.log(`  Qdrant collection '${COLLECTION}' points: ${pointsCount}`);
}

main().catch((err) => {
  console.error('Indexing failed:', err);
  process.exit(1);
});


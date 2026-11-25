import dotenv from 'dotenv';
dotenv.config();

import { AutoTokenizer, AutoModel } from '@huggingface/transformers';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ChunkPayload } from './types.js';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const COLLECTION = process.env.QDRANT_COLLECTION ?? 'rag_papers';
const DATA_DIR = join(process.cwd(), 'data');
const GRAPH_PATH = join(DATA_DIR, 'citation_graph.json');

const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
const TOP_K = 5;

let tokenizer: any;
let model: any;

async function loadEmbedder(): Promise<void> {
  if (!tokenizer) {
    tokenizer = await AutoTokenizer.from_pretrained(EMBED_MODEL);
    model = await AutoModel.from_pretrained(EMBED_MODEL);
  }
}

function to2D(arr: any, rows: number): number[][] {
  if (Array.isArray(arr)) return arr as number[][];
  const dims = arr.dims ?? [rows, Math.floor(arr.length / rows)];
  const data = arr.data as number[];
  const cols = dims[1];
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) out.push(data.slice(r * cols, (r + 1) * cols));
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
        for (let h = 0; h < hidden; h++) sum[h] += lastHidden[base + s * hidden + h];
      }
    }
    const vec: number[] = [];
    for (let h = 0; h < hidden; h++) vec.push(count > 0 ? sum[h] / count : 0);
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

async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}

function titleOf(nodeById: Map<string, any>, id: string): string {
  return nodeById.get(id)?.title ?? id;
}

async function qdrantSearch(vector: number[], limit: number): Promise<any[]> {
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Qdrant search failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { result: any[] };
  return data.result ?? [];
}

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ') || 'retrieval augmented generation';
  await loadEmbedder();
  const queryVector = await embedText(query);

  const results = await qdrantSearch(queryVector, TOP_K);

  const graphRaw = await readFile(GRAPH_PATH, 'utf8');
  const graph = JSON.parse(graphRaw);
  const nodeById = new Map<string, any>(graph.nodes.map((n: any) => [n.id, n]));

  const outNeighbors = new Map<string, string[]>();
  const inNeighbors = new Map<string, string[]>();
  for (const e of graph.edges) {
    const a = outNeighbors.get(e.source) ?? [];
    a.push(e.target);
    outNeighbors.set(e.source, a);
    const b = inNeighbors.get(e.target) ?? [];
    b.push(e.source);
    inNeighbors.set(e.target, b);
  }

  console.log(`\nQuery: "${query}"`);
  console.log(`Top ${TOP_K} semantic matches (enriched with citation context):\n`);

  for (const r of results) {
    const p = r.payload as ChunkPayload;
    const outs = (outNeighbors.get(p.paper_id) ?? []).map((id: string) => titleOf(nodeById, id));
    const ins = (inNeighbors.get(p.paper_id) ?? []).map((id: string) => titleOf(nodeById, id));
    const score = typeof r.score === 'number' ? r.score.toFixed(4) : 'n/a';

    console.log(`[${score}] ${p.title} (${p.year ?? 'n/a'})`);
    console.log(`  Snippet: ${p.text.slice(0, 300)}`);
    console.log(`  Cites (out): ${outs.length ? outs.join('; ') : 'none'}`);
    console.log(`  Cited by (in): ${ins.length ? ins.join('; ') : 'none'}\n`);
  }
}

main().catch((err) => {
  console.error('Search failed:', err);
  process.exit(1);
});

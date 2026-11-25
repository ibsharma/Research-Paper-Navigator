import dotenv from 'dotenv';
dotenv.config();

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { PaperMeta } from './types.js';

const DOMAIN_QUERY = process.env.DOMAIN_QUERY ?? 'retrieval augmented generation';
const PAPER_LIMIT = Number(process.env.PAPER_LIMIT ?? 50);
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY ?? '';
const BASE_DIR = process.cwd();
const DATA_DIR = join(BASE_DIR, 'data');
const PDFS_DIR = join(DATA_DIR, 'raw_pdfs');
const META_PATH = join(DATA_DIR, 'papers_meta.json');

const POLITE_USER_AGENT =
  'Research-Paper-Navigator/1.0 (mailto:research-paper-navigator@example.com)';

function openAlexUrl(): string {
  let url =
    `https://api.openalex.org/works?search=${encodeURIComponent(
      DOMAIN_QUERY,
    )}&filter=is_oa:true&sort=cited_by_count:desc&per-page=${PAPER_LIMIT}`;
  if (OPENALEX_API_KEY) {
    url += `&api_key=${encodeURIComponent(OPENALEX_API_KEY)}`;
  }
  return url;
}

function normalizeOpenAlexId(id: string): string {
  return id.replace(/^https:\/\/openalex\.org\//, '');
}

function extractArxivId(work: any): string | null {
  let arxiv = work.ids?.arxiv ?? null;
  if (!arxiv) {
    for (const loc of work.locations ?? []) {
      if (!loc) continue;
      const candidates = [loc.pdf_url, loc.landing_page_url];
      for (const u of candidates) {
        if (!u || !/arxiv\.org/.test(u)) continue;
        const m = String(u).match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,})/);
        if (m) {
          arxiv = m[1];
          break;
        }
      }
      if (arxiv) break;
    }
  }
  if (arxiv) {
    const m = String(arxiv).match(/([0-9]{4}\.[0-9]{4,})/);
    return m ? m[1] : null;
  }
  return null;
}

function reconstructAbstract(abstractInvertedIndex: any): string {
  if (!abstractInvertedIndex || typeof abstractInvertedIndex !== 'object') {
    return '';
  }
  const entries: { word: string; pos: number }[] = [];
  let maxPos = -1;
  for (const [word, posList] of Object.entries(abstractInvertedIndex)) {
    for (const pos of posList as number[]) {
      const p = Number(pos);
      entries.push({ word, pos: p });
      if (p > maxPos) maxPos = p;
    }
  }
  if (maxPos < 0) return '';
  const words: string[] = new Array(maxPos + 1);
  for (const { word, pos } of entries) {
    words[pos] = word;
  }
  return words.join(' ');
}

function extractPdfUrl(work: any): string | null {
  const locations: any[] = work.locations ?? [];
  for (const loc of locations) {
    if (loc?.pdf_url) return loc.pdf_url;
  }
  return work.open_access?.oa_url ?? null;
}

async function downloadPdf(url: string, dest: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': POLITE_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const header = buf.subarray(0, 5).toString('latin1');
    if (!header.startsWith('%PDF')) return false;
    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': POLITE_USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PDFS_DIR, { recursive: true });

  const url = openAlexUrl();
  console.log(
    `Fetching up to ${PAPER_LIMIT} open-access papers for "${DOMAIN_QUERY}" from OpenAlex...`,
  );
  const res = await fetch(url, { headers: { 'User-Agent': POLITE_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`OpenAlex request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as any;
  const works: any[] = data.results ?? [];
  console.log(`Received ${works.length} works from OpenAlex.`);

  const papers: PaperMeta[] = [];
  let pdfDownloaded = 0;
  let pdfFailed = 0;

  for (let i = 0; i < works.length; i++) {
    const w = works[i];
    const id = normalizeOpenAlexId(w.id);
    const title = w.title ?? '';
    const year = w.publication_year ?? null;
    const authors = (w.authorships ?? [])
      .map((a: any) => a.author?.display_name ?? '')
      .filter(Boolean);
    const cited_by_count = w.cited_by_count ?? 0;
    const arxiv_id = extractArxivId(w);
    const pdf_url = extractPdfUrl(w);
    const abstract = reconstructAbstract(w.abstract_inverted_index);

    const pdfDest = join(PDFS_DIR, `${id}.pdf`);
    let downloaded = false;

    if (pdf_url) {
      downloaded = await downloadPdf(pdf_url, pdfDest);
    }

    if (!downloaded && arxiv_id) {
      const arxivPdfUrl = `https://arxiv.org/pdf/${arxiv_id}.pdf`;
      console.log(
        `  [${i + 1}/${works.length}] OpenAlex PDF unavailable, trying arXiv fallback: ${arxivPdfUrl}`,
      );
      downloaded = await downloadPdf(arxivPdfUrl, pdfDest);
    }

    if (downloaded) pdfDownloaded++;
    else pdfFailed++;

    papers.push({
      id,
      title,
      year,
      authors,
      cited_by_count,
      arxiv_id,
      pdf_url,
      abstract,
      referenced_works: (w.referenced_works ?? []).map(normalizeOpenAlexId),
    });

    const status = downloaded ? 'PDF ok' : 'PDF failed';
    console.log(
      `  [${i + 1}/${works.length}] ${id} ${status} | cited_by=${cited_by_count} | ${title.slice(0, 80)}`,
    );
  }

  await writeFile(META_PATH, JSON.stringify(papers, null, 2));

  console.log(`\nPaper acquisition complete.`);
  console.log(`  Papers saved: ${papers.length} -> data/papers_meta.json`);
  console.log(`  PDFs downloaded: ${pdfDownloaded}`);
  console.log(`  PDFs failed (abstract fallback will be used): ${pdfFailed}`);
  console.log(`  PDFs stored in: data/raw_pdfs/`);
}

main().catch((err) => {
  console.error('Fetch failed:', err);
  process.exit(1);
});


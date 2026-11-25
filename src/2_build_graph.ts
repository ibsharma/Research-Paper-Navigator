import dotenv from 'dotenv';
dotenv.config();

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { PaperMeta, GraphNode, GraphEdge, CitationGraph } from './types.js';

const DATA_DIR = join(process.cwd(), 'data');
const META_PATH = join(DATA_DIR, 'papers_meta.json');
const GRAPH_PATH = join(DATA_DIR, 'citation_graph.json');
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY ?? '';

const BRIDGE_THRESHOLD = 3;
const BATCH_SIZE = 100;

function normalizeId(id: string): string {
  return id.replace(/^https:\/\/openalex\.org\//, '');
}

function openAlexBatchUrl(ids: string[]): string {
  const filter = `openalex:${ids.join('|')}`;
  let url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${ids.length}`;
  if (OPENALEX_API_KEY) {
    url += `&api_key=${encodeURIComponent(OPENALEX_API_KEY)}`;
  }
  return url;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAlex request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchBridgeMetadata(ids: string[]): Promise<Map<string, { title: string; year: number | null }>> {
  const meta = new Map<string, { title: string; year: number | null }>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const data = await fetchJson(openAlexBatchUrl(batch));
    for (const work of data.results ?? []) {
      meta.set(normalizeId(work.id), {
        title: work.title ?? '',
        year: work.publication_year ?? null,
      });
    }
  }
  return meta;
}

export async function main(): Promise<void> {
  const raw = await readFile(META_PATH, 'utf8');
  const papers: PaperMeta[] = JSON.parse(raw);
  const seedIds = new Set(papers.map((p) => p.id));

  // ---- Seed nodes ----
  const nodes: GraphNode[] = papers.map((p) => ({
    id: p.id,
    title: p.title,
    year: p.year,
    type: 'seed' as const,
    in_degree: 0,
    out_degree: 0,
  }));

  const degreeIn = new Map<string, number>();
  const degreeOut = new Map<string, number>();
  for (const n of nodes) {
    degreeIn.set(n.id, 0);
    degreeOut.set(n.id, 0);
  }

  // ---- Internal edges (seed cites seed) ----
  const edges: GraphEdge[] = [];
  for (const p of papers) {
    let cites = 0;
    for (const refId of p.referenced_works) {
      const target = normalizeId(refId);
      if (seedIds.has(target)) {
        edges.push({ source: p.id, target, relation: 'CITES' });
        cites++;
      }
    }
    degreeOut.set(p.id, cites);
  }
  for (const e of edges) {
    degreeIn.set(e.target, (degreeIn.get(e.target) ?? 0) + 1);
  }

  // ---- Bridge nodes: external IDs cited by at least 3 seed papers ----
  const citationFrequency = new Map<string, number>();
  for (const p of papers) {
    for (const refId of p.referenced_works) {
      const target = normalizeId(refId);
      if (!seedIds.has(target)) {
        citationFrequency.set(target, (citationFrequency.get(target) ?? 0) + 1);
      }
    }
  }
  const bridgeIds = [...citationFrequency.entries()]
    .filter(([, count]) => count >= BRIDGE_THRESHOLD)
    .map(([id]) => id);

  console.log(`Bridge candidates cited by >= ${BRIDGE_THRESHOLD} seeds: ${bridgeIds.length}`);

  const bridgeMeta = await fetchBridgeMetadata(bridgeIds);

  for (const bid of bridgeIds) {
    const m = bridgeMeta.get(bid) ?? { title: '', year: null };
    nodes.push({ id: bid, title: m.title, year: m.year, type: 'bridge', in_degree: 0, out_degree: 0 });
    degreeIn.set(bid, 0);
    degreeOut.set(bid, 0);
  }

  // ---- Bridge edges (seed cites bridge) ----
  const bridgeIdSet = new Set(bridgeIds);
  for (const p of papers) {
    for (const refId of p.referenced_works) {
      const target = normalizeId(refId);
      if (bridgeIdSet.has(target)) {
        edges.push({ source: p.id, target, relation: 'CITES' });
      }
    }
  }

  // ---- Final degrees over the full edge set ----
  for (const n of nodes) {
    degreeIn.set(n.id, 0);
    degreeOut.set(n.id, 0);
  }
  for (const e of edges) {
    degreeOut.set(e.source, (degreeOut.get(e.source) ?? 0) + 1);
    degreeIn.set(e.target, (degreeIn.get(e.target) ?? 0) + 1);
  }
  for (const n of nodes) {
    n.in_degree = degreeIn.get(n.id) ?? 0;
    n.out_degree = degreeOut.get(n.id) ?? 0;
  }

  const internalEdges = edges.filter((e) => seedIds.has(e.source) && seedIds.has(e.target)).length;

  const graph: CitationGraph = {
    stats: {
      total_nodes: nodes.length,
      internal_edges: internalEdges,
      bridge_nodes: bridgeIds.length,
    },
    nodes,
    edges,
  };

  await writeFile(GRAPH_PATH, JSON.stringify(graph, null, 2));

  console.log(`\nCitation graph complete.`);
  console.log(`  Total nodes: ${graph.stats.total_nodes} (seed: ${papers.length}, bridge: ${graph.stats.bridge_nodes})`);
  console.log(`  Internal edges (seed-seed): ${graph.stats.internal_edges}`);
  console.log(`  Total edges: ${edges.length}`);
  console.log(`  Saved to: data/citation_graph.json`);
}

main().catch((err) => {
  console.error('Graph build failed:', err);
  process.exit(1);
});

# Research-Paper-Navigator

Research Paper Navigator with Citation Graph — a local TypeScript (Node.js) pipeline that collects foundational papers in the **retrieval augmented generation (RAG)** domain, extracts a directed citation graph, indexes full-text chunks into Qdrant vector search, and provides a semantic + citation-aware CLI.

---

## Problem Statement

When researchers read many papers, they struggle with:

- **Finding original sources** — "Who first proved this?"
- **Spotting disagreements** — "Do these papers conflict?"
- **Tracing method history** — "How did this technique evolve?"

Today's search tools find relevant papers but fabricate or guess at provenance. They don't show how ideas connect or where conflicts occur.

---

## What It Does

The project is a 4-step pipeline (`npm run fetch` → `npm run graph` → `npm run index` → `npm run search`):

### 1. Paper Acquisition (`src/1_fetch_papers.ts`)

Queries the **OpenAlex REST API** for up to 50 open-access papers matching `"retrieval augmented generation"`, sorted by citation count descending. Normalizes OpenAlex IDs (strips `https://openalex.org/` prefix), extracts arXiv IDs, and reconstructs abstracts from OpenAlex's `abstract_inverted_index`. Downloads each PDF into `data/raw_pdfs/<id>.pdf` with a 15-second timeout and `User-Agent` header — tries OpenAlex `pdf_url` first, falls back to `https://arxiv.org/pdf/{arxiv_id}.pdf`, validates `%PDF` header, and gracefully skips failures. Saves normalized metadata to `data/papers_meta.json`.

### 2. Citation Graph Extraction (`src/2_build_graph.ts`)

Reads `data/papers_meta.json` and builds a `CitationGraph` saved to `data/citation_graph.json`. **Seed nodes:** all 50 papers (`type: "seed"`). **Internal edges:** directed citations where both source and target are in the seed set. **Bridge nodes:** external paper IDs cited by **at least 3** seed papers (`type: "bridge"`), with titles/years fetched in batch from OpenAlex. Computes `in_degree` and `out_degree` for every node.

### 3. Qdrant Indexing (`src/3_index_qdrant.ts`)

Connects to local Qdrant (`http://localhost:6333`) and recreates collection `rag_papers` (384 dims, Cosine distance). Extracts full text from each PDF using **unpdf**; falls back to `title + abstract` if PDF is missing/unreadable. Cleans whitespace and chunks text into ~1,200-character segments with 200-character overlap on sentence boundaries. Generates 384-dimensional normalized embeddings using **Xenova/bge-small-en-v1.5** (`@huggingface/transformers`, mean pooling). Upserts points to Qdrant in batches of 50 with typed `ChunkPayload`. Logs PDF vs. abstract fallback counts and verifies final point count.

### 4. Semantic Search + Citation Lookup CLI (`src/4_search.ts`)

Accepts a natural language query: `npm run search -- "how does GraphRAG improve global summarization"`. Embeds the query with `Xenova/bge-small-en-v1.5` and queries Qdrant for top 5 matching chunks. Enriches each result using `data/citation_graph.json` to display: (1) Similarity score, Paper Title, Year; (2) Matched text snippet (first 300 chars); (3) **Citation Context:** papers this paper cites (out-neighbors) and papers that cite it (in-neighbors).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v20+ (TypeScript, `strict: true`, executed via `tsx`) |
| Language | TypeScript (`"type": "module"` in `package.json`) |
| Vector DB | Qdrant (`qdrant/qdrant:latest` on HTTP port `6333`) |
| Paper / Citation Data | OpenAlex REST API (`https://api.openalex.org/works`) |
| Embeddings | `@huggingface/transformers` — `Xenova/bge-small-en-v1.5` (384 dims, Cosine) |
| PDF Parsing | `unpdf` (v2) |
| HTTP | native `fetch` |
| Env | `dotenv` |

### Dependencies
- **Production:** `@qdrant/js-client-rest`, `@huggingface/transformers`, `unpdf`, `dotenv`
- **Dev:** `typescript`, `tsx`, `@types/node`

---

## Directory Structure

```text
.
├── docker-compose.yml          # Qdrant: port 6333:6333, volume ./qdrant_storage:/qdrant/storage
├── package.json                # Scripts: typecheck, fetch, graph, index, search
├── tsconfig.json               # ES2022, NodeNext, strict, noEmit
├── .env.example / .env         # DOMAIN_QUERY, PAPER_LIMIT=50, QDRANT_URL, QDRANT_COLLECTION, OPENALEX_API_KEY
├── SPEC.md                     # Full project specification
├── README.md                   # This file
├── data/
│   ├── raw_pdfs/               # Downloaded PDFs named <short_id>.pdf
│   ├── papers_meta.json        # Normalized metadata for the 50 RAG papers
│   └── citation_graph.json     # Extracted nodes and directed citation edges
├── node_modules/
├── package-lock.json
└── src/
    ├── types.ts                # Shared TypeScript interfaces
    ├── 1_fetch_papers.ts       # Fetch metadata & download PDFs from OpenAlex/arXiv
    ├── 2_build_graph.ts        # Extract internal & bridge citation graph
    ├── 3_index_qdrant.ts       # Parse PDFs, chunk text, embed, upsert to Qdrant
    └── 4_search.ts             # CLI semantic search enriched with citation links
```

---

## Setup & Installation

### Prerequisites
- **Node.js v20+** and **npm**
- **Docker** (to run Qdrant locally)

### Install dependencies
```cmd
npm install
```

### Start Qdrant
```cmd
docker compose up -d
```
This starts `qdrant/qdrant:latest` on `http://localhost:6333` with data persisted to `./qdrant_storage`.

### Environment
Copy `.env.example` to `.env` and adjust if needed:
```cmd
copy .env.example .env
```
`OPENALEX_API_KEY` is optional — leave blank for the free keyless tier.

---

## Usage

Run the pipeline steps in order:

| Step | Command | Purpose |
|---|---|---|
| Type check | `npm run typecheck` | Verify zero TypeScript errors (`tsc --noEmit`) |
| 1. Fetch | `npm run fetch` | Download 50 RAG papers + PDFs from OpenAlex |
| 2. Graph | `npm run graph` | Build citation graph (`data/citation_graph.json`) |
| 3. Index | `npm run index` | Parse, chunk, embed, upsert to Qdrant |
| 4. Search | `npm run search -- "<query>"` | Semantic search with citation context |

**Example search:**
```cmd
npm run search -- "dense passage retrieval vs parametric memory"
```

**Example output:**
```
Query: "dense passage retrieval vs parametric memory"

Top 5 semantic matches (enriched with citation context):

[0.8734] DPR: Dense Passage Retrieval for Open-Domain Question Answering (2020)
  Snippet: Dense Passage Retrieval (DPR) is a ...
  Cites (out): BERT; RoBERTa; ...
  Cited by (in): Atlas; RETRO; ...
```

---

## Output Files

| File | Description |
|---|---|
| `data/papers_meta.json` | Array of 50 `PaperMeta` objects (id, title, year, authors, citations, arxiv_id, pdf_url, abstract, referenced_works) |
| `data/raw_pdfs/<id>.pdf` | Downloaded PDFs (one per successfully fetched paper) |
| `data/citation_graph.json` | `CitationGraph` with stats (total_nodes, internal_edges, bridge_nodes), nodes, and directed `CITES` edges |
| `./qdrant_storage/` | Qdrant persistent data volume |

---

## Acceptance Criteria

1. `npm install` and `npm run typecheck` — zero TypeScript errors
2. `docker compose up -d` — Qdrant running on `localhost:6333`
3. `npm run fetch` — `data/papers_meta.json` contains 50 RAG papers; PDFs saved in `data/raw_pdfs/`
4. `npm run graph` — `data/citation_graph.json` generated with valid `nodes`, `edges`, and non-zero `stats`
5. `npm run index` — Qdrant collection `rag_papers` holds indexed points
6. `npm run search -- "<query>"` — ranked chunks and citation neighbors print cleanly

---

## Notes

- `unpdf` was corrected from the spec's `^0.7.5` (non-existent) to `^2.2.2`, using the v2 API (`getDocumentProxy` + `extractText`).
- All relative TypeScript imports use explicit `.js` extensions as required by `moduleResolution: "NodeNext"`.
- If a PDF download fails, the pipeline continues using the paper's title + abstract as the indexing text source.




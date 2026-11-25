# Project Specification: RAG Literature Citation Graph & Qdrant Search Foundation (TypeScript)

## 1. Objective
Build a local TypeScript (Node.js) pipeline that collects 50 foundational and high-impact academic papers in the **"retrieval augmented generation"** domain, organizes their PDFs and metadata, extracts a directed citation graph, indexes full-text chunks into a local Qdrant vector database, and provides a working semantic + citation-aware search CLI.

## 2. Technical Stack & Constraints
- **Runtime & Language:** Node.js v20+ with **TypeScript** (`strict: true`), executed directly via `tsx` (`"type": "module"` in `package.json`).
- **Vector Database:** Qdrant running locally via Docker (`qdrant/qdrant:latest` on HTTP port `6333`).
- **Paper & Citation Data Source:** OpenAlex REST API (`https://api.openalex.org/works`) — free to query without an API key (or with an optional free `OPENALEX_API_KEY` for higher daily limits), returning clean `referenced_works` arrays and open-access PDF URLs.
- **Embeddings:** Local offline embeddings via `@huggingface/transformers` using `Xenova/bge-small-en-v1.5` (384 dimensions, Cosine distance) so indexing costs \$0 and requires no external API keys.
- **Dependencies:**
  - Production: `@qdrant/js-client-rest`, `unpdf`, `@huggingface/transformers`, `dotenv`
  - Dev: `typescript`, `tsx`, `@types/node`
- **Code Style:** Strict TypeScript interfaces in `src/types.ts`, `async/await`, native `fetch`, modular single-responsibility files, clear console progress logs, and graceful error handling (e.g., falling back to abstract if an individual PDF download fails).

## 3. Configuration (`.env.example` & `.env`)
- `DOMAIN_QUERY="retrieval augmented generation"`
- `PAPER_LIMIT=50`
- `QDRANT_URL="http://localhost:6333"`
- `QDRANT_COLLECTION="rag_papers"`
- `OPENALEX_API_KEY=""` *(Optional: leave blank for keyless free tier, or add a free key from openalex.org)*

## 4. Directory Structure
```text
.
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── SPEC.md
├── data/
│   ├── raw_pdfs/            # Downloaded PDFs named <short_id>.pdf
│   ├── papers_meta.json     # Normalized metadata for the 50 RAG papers
│   └── citation_graph.json  # Extracted nodes and directed citation edges
└── src/
    ├── types.ts             # Shared TypeScript interfaces
    ├── 1_fetch_papers.ts    # Fetch metadata & download PDFs from OpenAlex/arXiv
    ├── 2_build_graph.ts     # Extract internal & bridge citation graph
    ├── 3_index_qdrant.ts    # Parse PDFs, chunk text, embed, upsert to Qdrant
    └── 4_search.ts          # CLI semantic search enriched with citation links
```

## 5. Functional Requirements & Deliverables

### Deliverable 1: Infrastructure & TypeScript Setup (`docker-compose.yml`, `tsconfig.json`, `package.json`)
- `docker-compose.yml` must run `qdrant/qdrant:latest`, expose port `6333:6333`, and persist data to `./qdrant_storage:/qdrant/storage`.
- `tsconfig.json` must target `ES2022`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, and `noEmit: true`.
- `package.json` must include npm scripts:
  - `"typecheck": "tsc --noEmit"`
  - `"fetch": "tsx src/1_fetch_papers.ts"`
  - `"graph": "tsx src/2_build_graph.ts"`
  - `"index": "tsx src/3_index_qdrant.ts"`
  - `"search": "tsx src/4_search.ts"`

### Deliverable 2: Shared Types (`src/types.ts`)
Define explicit TypeScript interfaces for:
- `PaperMeta`: `{ id: string; title: string; year: number | null; authors: string[]; cited_by_count: number; arxiv_id: string | null; pdf_url: string | null; abstract: string; referenced_works: string[]; }`
- `GraphNode`: `{ id: string; title: string; year: number | null; type: "seed" | "bridge"; in_degree: number; out_degree: number; }`
- `GraphEdge`: `{ source: string; target: string; relation: "CITES"; }`
- `CitationGraph`: `{ stats: { total_nodes: number; internal_edges: number; bridge_nodes: number }; nodes: GraphNode[]; edges: GraphEdge[]; }`
- `ChunkPayload`: `{ paper_id: string; title: string; year: number | null; chunk_index: number; source_type: "pdf" | "abstract"; text: string; }`

### Deliverable 3: Paper Acquisition (`src/1_fetch_papers.ts`)
- Query OpenAlex `/works` searching for `"retrieval augmented generation"` (`search=retrieval+augmented+generation`), filtering by `is_oa:true`, sorted by `cited_by_count:desc`, fetching `PAPER_LIMIT` (50) papers (append `&api_key=...` only if `OPENALEX_API_KEY` is non-empty).
- Normalize OpenAlex IDs by stripping the `https://openalex.org/` prefix (e.g., `W3035054409`).
- Extract `arxiv_id` if present in `ids.arxiv` or `locations` (e.g., `2005.11401`) and reconstruct `abstract` from OpenAlex's `abstract_inverted_index`.
- Download each PDF into `data/raw_pdfs/<id>.pdf` using a 15-second `AbortSignal.timeout(15000)` and a descriptive `User-Agent` header:
  - Try `pdf_url` first; if it fails or returns non-PDF bytes (check `%PDF` header), fall back to `https://arxiv.org{arxiv_id}.pdf` when `arxiv_id` is available.
  - If both fail, log a warning and continue without crashing.
- Save the `PaperMeta[]` array to `data/papers_meta.json`.

### Deliverable 4: Citation Graph Extractor (`src/2_build_graph.ts`)
- Read `data/papers_meta.json` and construct a `CitationGraph` saved to `data/citation_graph.json`:
  - **Seed Nodes:** All 50 papers in `papers_meta.json` (`type: "seed"`).
  - **Internal Edges:** Directed edges (`source` cites `target`) where both `source` and `target` exist in the 50 seed papers.
  - **Bridge Nodes (Semi-Automatic Expansion):** External referenced paper IDs cited by **at least 3** of the 50 seed papers (`type: "bridge"`), along with the directed edges pointing to them. Fetch their titles and publication years from OpenAlex `/works` in a single batch filter (`filter=openalex:W1|W2|...`) so bridge nodes have human-readable titles.
  - Compute `in_degree` and `out_degree` within the graph for every node.

### Deliverable 5: Qdrant Indexing Pipeline (`src/3_index_qdrant.ts`)
- Connect to Qdrant at `QDRANT_URL`. Recreate collection `rag_papers` with vector size `384` and distance `Cosine`.
- For each `PaperMeta` in `data/papers_meta.json`:
  - Extract full text from `data/raw_pdfs/<id>.pdf` using `unpdf`. If missing or unreadable, fall back to `${paper.title}. ${paper.abstract}`.
  - Clean excessive whitespace and split text into chunks of **~1,200 characters** with **200-character overlap** on sentence/paragraph boundaries.
  - Generate 384-d normalized embeddings using `@huggingface/transformers` (`Xenova/bge-small-en-v1.5`, pooling: `'mean'`, normalize: `true`).
  - Upsert points into Qdrant in batches of 50 with sequential numeric IDs and typed `ChunkPayload`.
- Log total papers processed, PDF vs. abstract fallback count, total chunks indexed, and verify final point count via Qdrant collection info.

### Deliverable 6: Search & Citation Lookup CLI (`src/4_search.ts`)
- Accept a natural language query via CLI argument: `npm run search -- "how does GraphRAG improve global summarization"`.
- Embed the query using `Xenova/bge-small-en-v1.5` and query Qdrant for the top 5 matching chunks.
- Enrich each result using `data/citation_graph.json` to display:
  1. Similarity score, Paper Title, and Year
  2. Matched text snippet (first 300 chars)
  3. **Citation Context:** Titles/IDs of papers in the graph that this paper cites (`out_neighbors`) and papers in the graph that cite it (`in_neighbors`).

## 6. Acceptance Criteria & Verification
Cline must verify the implementation before completing the task:
1. Run `npm install` and `npm run typecheck` with zero TypeScript errors.
2. Verify `docker-compose.yml` syntax and confirm Qdrant is running on `localhost:6333` (or provide the exact `docker compose up -d` command if Docker is not currently running).
3. Run `npm run fetch` and confirm `data/papers_meta.json` contains 50 RAG papers and PDFs are saved in `data/raw_pdfs/`.
4. Run `npm run graph` and confirm `data/citation_graph.json` is generated with valid `nodes`, `edges`, and non-zero `stats`.
5. Run `npm run index` and confirm Qdrant collection `rag_papers` holds indexed points.
6. Run `npm run search -- "dense passage retrieval vs parametric memory"` and confirm ranked chunks and citation neighbors print cleanly.

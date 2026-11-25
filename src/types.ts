export interface PaperMeta {
  id: string;
  title: string;
  year: number | null;
  authors: string[];
  cited_by_count: number;
  arxiv_id: string | null;
  pdf_url: string | null;
  abstract: string;
  referenced_works: string[];
}

export interface GraphNode {
  id: string;
  title: string;
  year: number | null;
  type: "seed" | "bridge";
  in_degree: number;
  out_degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: "CITES";
}

export interface CitationGraph {
  stats: { total_nodes: number; internal_edges: number; bridge_nodes: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ChunkPayload {
  paper_id: string;
  title: string;
  year: number | null;
  chunk_index: number;
  source_type: "pdf" | "abstract";
  text: string;
}

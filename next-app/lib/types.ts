export type PageKind = "create" | "update" | "done" | "conflict" | "redirect";

export interface WikiInfo {
  origin: string;
  api: string;
  articlePath: string;
  indexNs: string;
  pageNs: string;
  lang: string;
  sitename: string;
}

export interface PageRecord {
  num: number;
  numLabel: string;
  title: string;
  label: string | null;
  kind: PageKind;
  level: number | null;
  hasText: boolean;
  excerpt: string;
  user: string | null;
  timestamp: string | null;
  revid: number | null;
  thumb: string | null;
  full: string | null;
  url: string;
  otherTitles: string[];
  outOfRange: boolean;
  levelName: string | null;
  manual?: boolean;
  inPagelist?: boolean;
}

export interface IndexInfo {
  title: string;
  base: string;
  fileTitle: string;
  filePageUrl: string;
  url: string;
  revid: number | null;
  pagecount: number;
  thumbBase: string | null;
  labels: Record<string, string>;
  blankPages: number[];
}

export interface Stats {
  pagecount: number;
  markedBlank: number;
  existingPages: number;
  existingContentPages: number;
  create: number;
  update: number;
  done: number;
  conflict: number;
  redirect: number;
  textPages: number;
  candidates: number;
  pending: number;
  style: "bn" | "ascii";
  truncated: boolean;
}

export interface Analysis {
  wiki: WikiInfo;
  index: IndexInfo;
  stats: Stats;
  pages: PageRecord[];
  warnings: string[];
  markers: string[];
}

export interface SearchResult {
  title: string;
  snippet: string;
  source: "prefix" | "search";
}

export interface SearchResponse {
  query: string;
  wiki: string;
  results: SearchResult[];
  searchUrl: string;
}

export interface StatusPayload {
  loggedIn: boolean;
  user: string | null;
  wiki: string | null;
  config: {
    wiki: string;
  };
}

export interface BotSession {
  v: 1;
  origin: string;
  username: string;
  rights: string[];
  cookies: Record<string, string>;
  iat: number;
  exp: number;
}

export interface SaveResponse {
  status: "saved" | "dry_run" | "already_done" | "skipped" | "error";
  action?: "create" | "update";
  title?: string;
  level?: number | null;
  message: string;
  content?: string;
  excerpt?: string;
  newrevid?: number;
  code?: string;
}

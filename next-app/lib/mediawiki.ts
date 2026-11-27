import type {
  Analysis,
  IndexInfo,
  PageKind,
  PageRecord,
  SearchResult,
  Stats,
  WikiInfo,
} from "./types";

export const DEFAULT_WIKI = "https://bn.wikisource.org";
export const USER_AGENT =
  process.env.WIKI_USER_AGENT ||
  "WikisourceBlankPageTool/2.0 (Next.js proofreading helper)";

const DEFAULT_TIMEOUT = 45_000;
const MAX_EXISTING_PAGES = 5000;
const PAGE_BATCH = 40;
const THUMB_WIDTH = 500;
const FULL_WIDTH = 1280;

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const ASCII_DIGITS = "0123456789";
const BLANK_DASHES = new Set("—–−‒―‐-".split(""));

const NUMBERING_SCHEMES = new Set([
  "roman", "highroman", "lowroman", "lowerroman", "upperroman",
  "arabic", "decimal", "alpha", "loweralpha", "upperalpha",
  "letters", "latin", "bengali", "bn", "none",
]);

const LEVEL_NAMES: Record<number, string> = {
  0: "লেখাবিহীন",
  1: "অপ্রুফকৃত",
  2: "সমস্যাযুক্ত",
  3: "প্রুফকৃত",
  4: "যাচাইকৃত",
};

export class WikiError extends Error {
  code: string;
  details?: unknown;
  suggestions?: string[];

  constructor(
    message: string,
    options: { code?: string; details?: unknown; suggestions?: string[] } = {},
  ) {
    super(message);
    this.name = "WikiError";
    this.code = options.code ?? "error";
    this.details = options.details;
    this.suggestions = options.suggestions ?? [];
  }
}

export class LoginError extends WikiError {
  constructor(message: string, options: { code?: string; details?: unknown } = {}) {
    super(message, { code: options.code ?? "login-failed", details: options.details });
    this.name = "LoginError";
  }
}

class TokenError extends WikiError {
  constructor() {
    super("CSRF token expired", { code: "badtoken" });
    this.name = "TokenError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function toAsciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
}

export function toBnDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)]);
}

export function pageNumber(title: string): number | null {
  const suffix = title.split("/").pop() ?? "";
  if (!/^[0-9০-৯]+$/.test(suffix)) return null;
  return Number(toAsciiDigits(suffix));
}

export function digitStyle(title: string): "bn" | "ascii" {
  const suffix = title.split("/").pop() ?? "";
  return /[০-৯]/.test(suffix) ? "bn" : "ascii";
}

export function formatPageNumber(number: number, style: "bn" | "ascii"): string {
  return style === "bn" ? toBnDigits(number) : String(number);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
    mdash: "—", ndash: "–", minus: "−", hellip: "…",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const parsed = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    if (code.startsWith("#")) {
      const parsed = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

function isBlankMarker(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return compact.length > 0 && [...compact].every((char) => BLANK_DASHES.has(char));
}

function isNumberingScheme(value: string): boolean {
  const compact = value.toLowerCase().replace(/\s+/g, "");
  if (!compact) return true;
  if (!/^[a-z]+$/.test(compact)) return false;
  return NUMBERING_SCHEMES.has(compact) || compact.startsWith("prp");
}

export interface Pagelist {
  blankPages: Set<number>;
  labels: Map<number, string>;
  maxPage: number;
  tagCount: number;
}

export function parsePagelist(text: string): Pagelist {
  const result: Pagelist = {
    blankPages: new Set(),
    labels: new Map(),
    maxPage: 0,
    tagCount: 0,
  };
  const tagRe = /<pagelist\b([^>]*)>/gi;
  for (const tag of text.matchAll(tagRe)) {
    result.tagCount += 1;
    const attrs = tag[1] ?? "";
    const attrRe =
      /([0-9০-৯]+)\s*(?:(?:to|–|—|-)\s*([0-9০-৯]+))?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/gi;
    for (const match of attrs.matchAll(attrRe)) {
      const start = Number(toAsciiDigits(match[1] ?? ""));
      const end = match[2] ? Number(toAsciiDigits(match[2])) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        continue;
      }
      const raw = match[3] ?? match[4] ?? match[5] ?? "";
      const value = decodeEntities(raw).replace(/\s+/g, " ").trim();
      result.maxPage = Math.max(result.maxPage, end);
      if (isBlankMarker(value)) {
        for (let number = start; number <= end; number += 1) {
          result.blankPages.add(number);
        }
      } else if (value && !isNumberingScheme(value)) {
        for (let number = start; number <= end; number += 1) {
          if (!result.labels.has(number)) result.labels.set(number, value);
        }
      }
    }
  }
  return result;
}

export function bodyText(content: string | null | undefined): string {
  if (!content) return "";
  let text = content;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<noinclude\b[^>]*>[\s\S]*?<\/noinclude\s*>/gi, "");
  text = text.replace(/<pagequality\b[^>]*\/\s*>/gi, "");
  text = text.replace(/<pagequality\b[^>]*>[\s\S]*?<\/pagequality\s*>/gi, "");
  text = text.replace(
    /\{\{\s*(?:nop|gap|blank|empty|clear|dhr|rh|running\s+header|page\s+header|-)\s*(?:\|[^{}]*)?\}\}/gi,
    "",
  );
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/__[A-Z]+__/g, "");
  text = text.replace(/\u00a0/g, " ");
  return text.trim();
}

export function isBlankContent(content: string | null | undefined): boolean {
  return !/[\p{L}\p{N}]/u.test(bodyText(content));
}

export function parseQuality(content: string | null | undefined): {
  level: number | null;
  user: string | null;
} {
  if (!content) return { level: null, user: null };
  const tag = content.match(/<pagequality\b[^>]*>/i)?.[0];
  if (!tag) return { level: null, user: null };
  const levelMatch = tag.match(/\blevel\s*=\s*["']?(\d+)/i);
  const userMatch = tag.match(/\buser\s*=\s*["']([^"']*)/i);
  return {
    level: levelMatch ? Number(levelMatch[1]) : null,
    user: userMatch ? userMatch[1] : null,
  };
}

export function buildBlankContent(username: string): string {
  return `<noinclude><pagequality level="0" user="${escapeAttribute(username)}" /></noinclude>`;
}

export function setQualityZero(content: string, username: string): string {
  const newTag = `<pagequality level="0" user="${escapeAttribute(username)}" />`;
  if (/<pagequality\b[^>]*>[\s\S]*?<\/pagequality\s*>/i.test(content)) {
    return content.replace(/<pagequality\b[^>]*>[\s\S]*?<\/pagequality\s*>/i, newTag);
  }
  if (/<pagequality\b[^>]*\/\s*>/i.test(content)) {
    return content.replace(/<pagequality\b[^>]*\/\s*>/i, newTag);
  }
  return buildBlankContent(username) + content;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function excerpt(content: string, limit = 220): string {
  const text = bodyText(content).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function normalizeWiki(wiki: string): string {
  const value = (wiki || "").trim();
  if (!value) throw new WikiError("উইকির ঠিকানা দেওয়া হয়নি।", { code: "bad-wiki" });
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new WikiError("উইকির ঠিকানা ঠিক নয়।", { code: "bad-wiki" });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new WikiError("উইকির ঠিকানা ঠিক নয়।", { code: "bad-wiki" });
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function inferWikiFromInput(value: string): string | null {
  const match = (value || "").trim().match(/^https?:\/\/([^/\s]+)/i);
  return match ? `https://${match[1]}` : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// API types / client
// ---------------------------------------------------------------------------

interface SiteInfo {
  origin: string;
  api: string;
  lang: string;
  sitename: string;
  articlePath: string;
  nsIndex: string;
  nsPage: string;
  nsFile: string;
}

interface PageData {
  title: string;
  ns: number | null;
  missing: boolean;
  redirect: boolean;
  content: string | null;
  revid: number | null;
  user: string | null;
  timestamp: string | null;
}

interface ImageInfo {
  thumbUrl: string | null;
  pageCount: number;
  descriptionUrl: string | null;
}

const SITE_CACHE = new Map<string, SiteInfo>();

type ParamValue = string | number | boolean | undefined | null;

function paramsToSearch(params: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return search.toString();
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function absorbCookies(jar: Record<string, string>, response: Response): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  let setCookies = headers.getSetCookie?.() ?? [];
  if (!setCookies.length) {
    const combined = response.headers.get("set-cookie");
    if (combined) {
      setCookies = combined.split(/,(?=\s*[^;,]+=)/);
    }
  }
  for (const raw of setCookies) {
    const pair = raw.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (/expires=thu,\s*01\s+jan\s+1970|max-age=0(?:[;\s]|$)/i.test(raw)) {
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
}

export class WikiClient {
  origin: string;
  cookies: Record<string, string>;
  username: string;
  rights: string[];
  site: SiteInfo | null = null;
  private csrfToken: string | null = null;

  constructor(
    origin: string,
    options: { cookies?: Record<string, string>; username?: string; rights?: string[] } = {},
  ) {
    this.origin = normalizeWiki(origin);
    this.cookies = { ...(options.cookies ?? {}) };
    this.username = options.username ?? "";
    this.rights = options.rights ?? [];
  }

  async init(): Promise<SiteInfo> {
    if (this.site) return this.site;
    const cached = SITE_CACHE.get(this.origin);
    if (cached) {
      this.site = cached;
      return cached;
    }
    const candidates = [`${this.origin}/w/api.php`, `${this.origin}/api.php`];
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const url = `${candidate}?${paramsToSearch({
          action: "query",
          meta: "siteinfo",
          siprop: "general|namespaces",
          format: "json",
          formatversion: 2,
        })}`;
        const response = await fetch(url, {
          headers: this.headers(),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
          cache: "no-store",
        });
        absorbCookies(this.cookies, response);
        if (!response.ok) {
          lastError = new WikiError(`উইকি API (HTTP ${response.status})।`, {
            code: "http",
          });
          continue;
        }
        const data = (await response.json()) as {
          query?: {
            general?: Record<string, string>;
            namespaces?: Record<string, Record<string, unknown>>;
          };
        };
        const general = data.query?.general;
        const namespaces = data.query?.namespaces;
        if (!general || !namespaces) continue;
        const nsName = (id: number, fallback: string): string =>
          (namespaces[String(id)]?.["*"] as string | undefined) ??
          (namespaces[String(id)]?.name as string | undefined) ??
          fallback;
        const info: SiteInfo = {
          origin: this.origin,
          api: candidate,
          lang: general.lang ?? "en",
          sitename: general.sitename ?? "",
          articlePath: general.articlepath ?? "/wiki/$1",
          nsIndex: nsName(102, "Index"),
          nsPage: nsName(104, "Page"),
          nsFile: nsName(6, "File"),
        };
        SITE_CACHE.set(this.origin, info);
        this.site = info;
        return info;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof WikiError
      ? lastError
      : new WikiError("এই উইকির API পাওয়া যায়নি। ঠিকানা পরীক্ষা করুন।", {
          code: "no-api",
        });
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    const cookie = cookieHeader(this.cookies);
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  private async request(
    params: Record<string, ParamValue>,
    options: { method?: "GET" | "POST"; write?: boolean; retries?: number } = {},
  ): Promise<any> {
    const site = await this.init();
    const method = options.method ?? "GET";
    const payload: Record<string, ParamValue> = {
      ...params,
      format: "json",
      formatversion: 2,
    };
    if (options.write) payload.maxlag = 5;
    const retries = options.retries ?? 4;

    for (let attempt = 0; attempt < retries; attempt += 1) {
      let response: Response;
      try {
        if (method === "POST") {
          response = await fetch(site.api, {
            method: "POST",
            headers: {
              ...this.headers(),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: paramsToSearch(payload),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
            cache: "no-store",
          });
        } else {
          response = await fetch(`${site.api}?${paramsToSearch(payload)}`, {
            headers: this.headers(),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
            cache: "no-store",
          });
        }
      } catch (error) {
        if (attempt < retries - 1) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw new WikiError("উইকির সাথে সংযোগ করা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করুন।", {
          code: "network",
          details: String(error),
        });
      }
      absorbCookies(this.cookies, response);
      if (response.status === 429) {
        if (attempt < retries - 1) {
          const header = Number(response.headers.get("retry-after"));
          const wait =
            Number.isFinite(header) && header > 0
              ? Math.min(header, 20)
              : 2 * (attempt + 1);
          await sleep(wait * 1000);
          continue;
        }
        throw new WikiError(
          "উইকি সার্ভার এখন অনেক অনুরোধ পাচ্ছে (রেট লিমিট)। কয়েক সেকেন্ড অপেক্ষা করে আবার “বিশ্লেষণ করুন” চাপুন।",
          { code: "ratelimited" },
        );
      }
      if (response.status >= 500) {
        if (attempt < retries - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new WikiError(`উইকি API (HTTP ${response.status})।`, { code: "http" });
      }
      if (!response.ok) {
        throw new WikiError(`উইকি API (HTTP ${response.status})।`, { code: "http" });
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        if (attempt < retries - 1) {
          await sleep(700);
          continue;
        }
        throw new WikiError("উইকি API থেকে বৈধ JSON পাওয়া যায়নি।", {
          code: "bad-json",
        });
      }
      const error = data.error;
      if (error) {
        const code = String(error.code ?? "error");
        if (code === "maxlag" && attempt < retries - 1) {
          await sleep(Math.min(Number(error.lag ?? 5) + 1, 10) * 1000);
          continue;
        }
        if (code === "badtoken") throw new TokenError();
        throw new WikiError(String(error.info ?? "উইকি API ত্রুটি।"), {
          code,
          details: error,
        });
      }
      return data;
    }
    throw new WikiError("উইকি API বারবার ব্যস্ত আছে; কিছুক্ষণ পরে চেষ্টা করুন।", {
      code: "maxlag",
    });
  }

  private normalizePage(page: any): PageData {
    const revision = page.revisions?.[0];
    return {
      title: String(page.title ?? ""),
      ns: typeof page.ns === "number" ? page.ns : null,
      missing: Boolean(page.missing),
      redirect: Boolean(page.redirect),
      content: revision?.slots?.main?.content ?? revision?.["*"] ?? null,
      revid: revision?.revid ?? page.lastrevid ?? null,
      user: revision?.user ?? null,
      timestamp: revision?.timestamp ?? null,
    };
  }

  async getPage(title: string, followRedirects = false): Promise<PageData> {
    const params: Record<string, ParamValue> = {
      action: "query",
      prop: "info|revisions",
      rvprop: "ids|content|timestamp|user",
      rvslots: "main",
      titles: title,
    };
    if (followRedirects) params.redirects = 1;
    const data = await this.request(params);
    const pages = data.query?.pages ?? [];
    if (!pages.length) {
      throw new WikiError("উইকি থেকে পাতার তথ্য পাওয়া যায়নি।", { code: "no-page" });
    }
    return this.normalizePage(pages[0]);
  }

  async getPages(titles: string[]): Promise<PageData[]> {
    const unique = [...new Set(titles)];
    const results: PageData[] = [];
    for (let offset = 0; offset < unique.length; offset += PAGE_BATCH) {
      const batch = unique.slice(offset, offset + PAGE_BATCH);
      const joined = batch.join("|");
      const data = await this.request(
        {
          action: "query",
          prop: "info|revisions",
          rvprop: "ids|content|timestamp|user",
          rvslots: "main",
          titles: joined,
        },
        { method: joined.length > 3000 ? "POST" : "GET" },
      );
      for (const page of data.query?.pages ?? []) {
        results.push(this.normalizePage(page));
      }
      if (offset + PAGE_BATCH < unique.length) await sleep(120);
    }
    return results;
  }

  async listPageTitles(prefix: string): Promise<string[]> {
    const titles: string[] = [];
    let continuation: Record<string, ParamValue> = {};
    for (;;) {
      const data = await this.request({
        action: "query",
        list: "allpages",
        apnamespace: 104,
        apprefix: prefix,
        aplimit: 500,
        apfilterredir: "all",
        ...continuation,
      });
      for (const page of data.query?.allpages ?? []) titles.push(String(page.title));
      if (!data.continue) break;
      continuation = data.continue as Record<string, ParamValue>;
    }
    return titles;
  }

  async imageInfo(fileTitle: string): Promise<ImageInfo | null> {
    const data = await this.request({
      action: "query",
      prop: "imageinfo",
      iiprop: "url|size|mime",
      iiurlwidth: THUMB_WIDTH,
      titles: fileTitle,
    });
    const page = data.query?.pages?.[0];
    const info = page?.imageinfo?.[0];
    if (!info) return null;
    return {
      thumbUrl: info.thumburl ? String(info.thumburl).split("?")[0] : null,
      pageCount: Number(info.pagecount ?? 0),
      descriptionUrl: info.descriptionurl ? String(info.descriptionurl) : null,
    };
  }

  async searchIndexDetails(query: string, limit = 8): Promise<SearchResult[]> {
    let value = (query || "").trim();
    const site = await this.init();
    for (const prefix of [site.nsIndex, "Index"]) {
      if (value.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) {
        value = value.slice(prefix.length + 1);
        break;
      }
    }
    value = value.trim();
    if (value.length < 2) return [];

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    try {
      const data = await this.request({
        action: "query",
        list: "prefixsearch",
        pssearch: value,
        psnamespace: 102,
        pslimit: limit,
      });
      for (const item of data.query?.prefixsearch ?? []) {
        const title = String(item.title ?? "");
        if (title && !seen.has(title)) {
          seen.add(title);
          results.push({ title, snippet: "", source: "prefix" });
        }
      }
    } catch {
      // The full-text search below may still work.
    }
    if (results.length < limit) {
      try {
        const data = await this.request({
          action: "query",
          list: "search",
          srnamespace: 102,
          srsearch: value,
          srlimit: limit,
          srprop: "snippet",
        });
        for (const hit of data.query?.search ?? []) {
          const title = String(hit.title ?? "");
          if (!title || seen.has(title)) continue;
          const snippet = decodeEntities(
            String(hit.snippet ?? "").replace(/<[^>]+>/g, " "),
          )
            .replace(/\s+/g, " ")
            .trim();
          seen.add(title);
          results.push({ title, snippet, source: "search" });
        }
      } catch {
        // Return whatever we have.
      }
    }
    return results.slice(0, limit);
  }

  async searchIndex(query: string): Promise<string[]> {
    return (await this.searchIndexDetails(query)).map((item) => item.title);
  }

  // -- index resolution -----------------------------------------------------

  private async extractTitle(input: string): Promise<string> {
    let value = (input || "").trim();
    if (!value) throw new WikiError("বই বা নির্ঘণ্টের নাম লিখুন।", { code: "empty-input" });
    const site = await this.init();

    if (/^https?:\/\//i.test(value)) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new WikiError("লিংক থেকে নির্ঘণ্টের নাম পড়া যায়নি।", { code: "bad-url" });
      }
      const queryTitle = parsed.searchParams.get("title");
      if (queryTitle) {
        value = queryTitle;
      } else {
        const path = decodeURIComponent(parsed.pathname);
        const marker = "/wiki/";
        if (!path.includes(marker)) {
          throw new WikiError("লিংক থেকে নির্ঘণ্টের নাম পড়া যায়নি।", { code: "bad-url" });
        }
        value = path.split(marker)[1] ?? "";
      }
    }
    value = decodeURIComponent(value).replace(/_/g, " ").trim().replace(/^:+/, "");
    for (const prefix of [site.nsIndex, "Index"]) {
      if (value.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) {
        value = value.slice(prefix.length + 1);
        break;
      }
    }
    for (const prefix of [site.nsPage, "Page"]) {
      if (value.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) {
        throw new WikiError(
          "এটি একটি পাতা (Page:), নির্ঘণ্ট নয়। নির্ঘণ্ট পাতার নাম দিন।",
          { code: "page-not-index" },
        );
      }
    }
    for (const prefix of [site.nsFile, "File"]) {
      if (value.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) {
        value = value.slice(prefix.length + 1);
        break;
      }
    }
    value = value.trim();
    if (!value) throw new WikiError("নির্ঘণ্টের নাম খালি।", { code: "empty-input" });
    return value;
  }

  async resolveIndex(input: string): Promise<PageData> {
    const site = await this.init();
    const base = await this.extractTitle(input);
    const seen = new Set<string>();
    for (const prefix of [site.nsIndex, "Index"]) {
      const title = `${prefix}:${base}`;
      if (seen.has(title)) continue;
      seen.add(title);
      const page = await this.getPage(title, true);
      if (!page.missing && page.ns === 102) return page;
    }
    const hits = await this.searchIndex(base);
    if (hits.length) {
      throw new WikiError("এই নামে সরাসরি নির্ঘণ্ট পাওয়া যায়নি। নিচের ফলাফল থেকে বেছে নিন।", {
        code: "not-found",
        suggestions: hits,
      });
    }
    throw new WikiError(
      "এই নামে কোনো নির্ঘণ্ট পাতা পাওয়া যায়নি। ফাইলের নাম বা নির্ঘণ্ট পাতার লিংক ঠিকভাবে দিন।",
      { code: "not-found" },
    );
  }

  // -- analysis -------------------------------------------------------------

  async analyze(input: string): Promise<Analysis> {
    const site = await this.init();
    const index = await this.resolveIndex(input);
    const base = index.title.split(":").slice(1).join(":");
    const pagelist = parsePagelist(index.content ?? "");
    const fileTitle = `${site.nsFile}:${base}`;
    const info = await this.imageInfo(fileTitle);
    let pageCount = info?.pageCount ?? 0;
    const thumbBase = info?.thumbUrl ?? null;
    const filePageUrl = info?.descriptionUrl ?? this.pageUrl(fileTitle);

    const allTitles = await this.listPageTitles(`${base}/`);
    let numericTitles: Array<{ number: number; title: string }> = allTitles
      .map((title) => ({ number: pageNumber(title), title }))
      .filter((entry): entry is { number: number; title: string } =>
        entry.number !== null && entry.number >= 1,
      );
    const truncated = numericTitles.length > MAX_EXISTING_PAGES;
    if (truncated) numericTitles = numericTitles.slice(0, MAX_EXISTING_PAGES);

    const pages = (await this.getPages(numericTitles.map((entry) => entry.title)))
      .filter((page) => pageNumber(page.title) !== null);
    const style = this.inferStyle(pages);

    const byNumber = new Map<number, PageData[]>();
    for (const page of pages) {
      const number = pageNumber(page.title);
      if (number === null) continue;
      const group = byNumber.get(number) ?? [];
      group.push(page);
      byNumber.set(number, group);
    }

    if (!pageCount) {
      pageCount = Math.max(pagelist.maxPage, ...[...byNumber.keys()], 1);
    }

    const warnings: string[] = [];
    if (pagelist.tagCount === 0) {
      warnings.push("এই নির্ঘণ্টে <pagelist> পাওয়া যায়নি; শুধু বিদ্যমান খালি পাতাগুলো দেখানো হচ্ছে।");
    } else if (pagelist.blankPages.size === 0) {
      warnings.push("pagelist-এ ফাঁকা পাতার কোনো চিহ্ন (— বা -) পাওয়া যায়নি।");
    }
    if (!info) {
      warnings.push("স্ক্যান ফাইলের তথ্য পাওয়া যায়নি; পাতা সংখ্যা নির্ঘণ্ট থেকে অনুমান করা হয়েছে।");
    }
    if (truncated) {
      warnings.push(
        `এই বইয়ে ${toBnDigits(MAX_EXISTING_PAGES)}টির বেশি পাতা আছে; শুধু প্রথম ${toBnDigits(MAX_EXISTING_PAGES)}টি পরীক্ষা করা হয়েছে।`,
      );
    }
    if (pagelist.maxPage > pageCount) {
      const overflow = [...pagelist.blankPages].filter((number) => number > pageCount);
      if (overflow.length) {
        warnings.push(
          `${toBnDigits(overflow.length)}টি ফাঁকা পাতা স্ক্যানের মোট পাতা (${toBnDigits(pageCount)}) ছাড়িয়ে গেছে; সেগুলো আলাদা করে যাচাই করুন।`,
        );
      }
    }
    if (this.hasMixedStyles(pages)) {
      warnings.push(
        `এই বইয়ে বাংলা ও ইংরেজি — দুই রকম অঙ্কে পাতা তৈরি হয়েছে; নতুন পাতা ${
          style === "bn" ? "বাংলা" : "ইংরেজি"
        } অঙ্কে তৈরি হবে।`,
      );
    }

    const records: PageRecord[] = [];
    const labelsObject: Record<string, string> = {};
    for (const [number, label] of pagelist.labels) {
      labelsObject[String(number)] = label;
    }

    let textPages = 0;
    const duplicateNumbers = new Set<number>();
    const redirectRecords: number[] = [];

    for (const number of [...new Set([...pagelist.blankPages, ...byNumber.keys()])].sort(
      (a, b) => a - b,
    )) {
      const group = byNumber.get(number) ?? [];
      const inPagelist = pagelist.blankPages.has(number);
      const primary = this.choosePrimary(group, style);
      if (primary && !isBlankContent(primary.content) && !inPagelist) {
        textPages += 1;
        continue;
      }
      const record = this.buildRecord({
        number,
        group,
        inPagelist,
        manual: false,
        base,
        style,
        pageCount,
        thumbBase,
        label: pagelist.labels.get(number) ?? null,
        pageNs: site.nsPage,
      });
      if (!record) continue;
      if (record.kind === "redirect") redirectRecords.push(number);
      const nonRedirectOthers = group.filter(
        (page) => page !== primary && !page.redirect && !page.missing,
      );
      if (nonRedirectOthers.length) duplicateNumbers.add(number);
      records.push(record);
    }

    if (redirectRecords.length) {
      warnings.push(
        `${toBnDigits(redirectRecords.length)}টি ফাঁকা-চিহ্নিত পাতা শুধু পুনর্নির্দেশ হিসেবে আছে; সেগুলো লেখাবিহীন হিসেবে ধরা হয়নি।`,
      );
    }
    if (duplicateNumbers.size) {
      warnings.push(
        `${toBnDigits(duplicateNumbers.size)}টি স্ক্যান পাতার একাধিক পাতা আছে; নিরাপত্তার জন্য কার্ডে বিস্তারিত দেখুন।`,
      );
    }
    const conflicts = records.filter((record) => record.kind === "conflict").length;
    if (conflicts) {
      warnings.push(
        `${toBnDigits(conflicts)}টি ফাঁকা চিহ্নিত পাতায় লেখা আছে; ভুল এড়াতে সেগুলো বাদ দেওয়া হয়েছে।`,
      );
    }

    const stats: Stats = {
      pagecount: pageCount,
      markedBlank: pagelist.blankPages.size,
      existingPages: pages.length,
      existingContentPages: pages.filter((page) => !page.redirect).length,
      create: records.filter((record) => record.kind === "create").length,
      update: records.filter((record) => record.kind === "update").length,
      done: records.filter((record) => record.kind === "done").length,
      conflict: conflicts,
      redirect: records.filter((record) => record.kind === "redirect").length,
      textPages,
      candidates: records.length,
      pending: records.filter(
        (record) => record.kind === "create" || record.kind === "update",
      ).length,
      style,
      truncated,
    };

    const indexInfo: IndexInfo = {
      title: index.title,
      base,
      fileTitle,
      filePageUrl,
      url: this.pageUrl(index.title),
      revid: index.revid,
      pagecount: pageCount,
      thumbBase,
      labels: labelsObject,
      blankPages: [...pagelist.blankPages].sort((a, b) => a - b),
    };

    return {
      wiki: this.wikiInfo(),
      index: indexInfo,
      stats,
      pages: records,
      warnings,
      markers: [...BLANK_DASHES].sort(),
    };
  }

  async manualPageRecord(
    number: number,
    meta: {
      base: string;
      style: "bn" | "ascii";
      pageCount: number;
      thumbBase: string | null;
      label: string | null;
      inPagelist: boolean;
    },
  ): Promise<PageRecord> {
    const site = await this.init();
    if (!Number.isInteger(number) || number < 1 || (meta.pageCount && number > meta.pageCount)) {
      throw new WikiError("পাতার নম্বর স্ক্যানের সীমার বাইরে।", { code: "bad-num" });
    }
    const alternate = meta.style === "bn" ? "ascii" : "bn";
    const titles = [
      `${site.nsPage}:${meta.base}/${formatPageNumber(number, meta.style)}`,
      `${site.nsPage}:${meta.base}/${formatPageNumber(number, alternate)}`,
    ];
    const pages = (await this.getPages([...new Set(titles)])).filter(
      (page) => pageNumber(page.title) === number,
    );
    const record = this.buildRecord({
      number,
      group: pages,
      inPagelist: meta.inPagelist,
      manual: true,
      base: meta.base,
      style: meta.style,
      pageCount: meta.pageCount,
      thumbBase: meta.thumbBase,
      label: meta.label,
      pageNs: site.nsPage,
    });
    if (!record) {
      throw new WikiError("এই পাতার তথ্য তৈরি করা যায়নি।", { code: "no-record" });
    }
    record.manual = true;
    return record;
  }

  private inferStyle(pages: PageData[]): "bn" | "ascii" {
    let bn = 0;
    let ascii = 0;
    for (const page of pages) {
      if (page.redirect || page.missing) continue;
      if (digitStyle(page.title) === "bn") bn += 1;
      else ascii += 1;
    }
    if (bn && !ascii) return "bn";
    if (ascii && !bn) return "ascii";
    if (bn || ascii) return bn >= ascii ? "bn" : "ascii";
    return this.site?.lang === "bn" ? "bn" : "ascii";
  }

  private hasMixedStyles(pages: PageData[]): boolean {
    const styles = new Set(
      pages
        .filter((page) => !page.redirect && !page.missing)
        .map((page) => digitStyle(page.title)),
    );
    return styles.size > 1;
  }

  private choosePrimary(group: PageData[], style: "bn" | "ascii"): PageData | null {
    const candidates = group.filter((page) => !page.redirect && !page.missing);
    if (!candidates.length) return null;
    return [...candidates].sort((a, b) => {
      const aText = isBlankContent(a.content) ? 1 : 0;
      const bText = isBlankContent(b.content) ? 1 : 0;
      if (aText !== bText) return aText - bText;
      const aStyle = digitStyle(a.title) === style ? 0 : 1;
      const bStyle = digitStyle(b.title) === style ? 0 : 1;
      if (aStyle !== bStyle) return aStyle - bStyle;
      return a.title.localeCompare(b.title);
    })[0] ?? null;
  }

  private buildRecord(args: {
    number: number;
    group: PageData[];
    inPagelist: boolean;
    manual: boolean;
    base: string;
    style: "bn" | "ascii";
    pageCount: number;
    thumbBase: string | null;
    label: string | null;
    pageNs: string;
  }): PageRecord | null {
    const { number, group, inPagelist, manual, base, style, pageCount, thumbBase, label } = args;
    const primary = this.choosePrimary(group, style);
    const redirects = group.filter((page) => page.redirect);
    const chosen = primary ?? redirects[0] ?? null;
    const otherTitles = group
      .filter((page) => page !== chosen && !page.missing)
      .map((page) => page.title);

    let title: string;
    let kind: PageKind;
    let level: number | null = null;
    let hasText = false;
    let textExcerpt = "";
    let user: string | null = null;
    let timestamp: string | null = null;
    let revid: number | null = null;

    if (!primary) {
      if (redirects.length && (inPagelist || manual)) {
        const redirect = redirects[0]!;
        const quality = parseQuality(redirect.content);
        title = redirect.title;
        kind = "redirect";
        level = quality.level;
        user = redirect.user;
        timestamp = redirect.timestamp;
        revid = redirect.revid;
      } else if (inPagelist || manual) {
        title = `${args.pageNs}:${base}/${formatPageNumber(number, style)}`;
        kind = "create";
      } else {
        return null;
      }
    } else {
      const quality = parseQuality(primary.content);
      title = primary.title;
      level = quality.level;
      user = primary.user;
      timestamp = primary.timestamp;
      revid = primary.revid;
      if (isBlankContent(primary.content)) {
        kind = quality.level === 0 ? "done" : "update";
      } else if (inPagelist || manual) {
        kind = "conflict";
        hasText = true;
        textExcerpt = excerpt(primary.content ?? "");
      } else {
        return null;
      }
    }

    let thumb: string | null = null;
    let full: string | null = null;
    if (thumbBase && (!pageCount || number <= pageCount)) {
      thumb = thumbBase.replace(/page\d+-\d+px/, `page${number}-${THUMB_WIDTH}px`);
      full = thumbBase.replace(/page\d+-\d+px/, `page${number}-${FULL_WIDTH}px`);
    }

    const labelText = label && /^[0-9]+$/.test(label) ? toBnDigits(label) : label;

    return {
      num: number,
      numLabel: style === "bn" ? toBnDigits(number) : String(number),
      title,
      label: labelText,
      kind,
      level,
      hasText,
      excerpt: textExcerpt,
      user,
      timestamp,
      revid,
      thumb,
      full,
      url: this.pageUrl(title),
      otherTitles,
      outOfRange: Boolean(pageCount && number > pageCount),
      levelName: level === null ? null : LEVEL_NAMES[level] ?? null,
      manual,
      inPagelist,
    };
  }

  wikiInfo(): WikiInfo {
    const site = this.site!;
    return {
      origin: site.origin,
      api: site.api,
      articlePath: site.articlePath,
      indexNs: site.nsIndex,
      pageNs: site.nsPage,
      lang: site.lang,
      sitename: site.sitename,
    };
  }

  pageUrl(title: string): string {
    const site = this.site;
    const articlePath = site?.articlePath ?? "/wiki/$1";
    const quoted = encodeURIComponent(title.replace(/ /g, "_"))
      .replace(/%2F/g, "/")
      .replace(/%3A/g, ":");
    if (articlePath.includes("$1")) return `${this.origin}${articlePath.replace("$1", quoted)}`;
    return `${this.origin}${articlePath.replace(/\/$/, "")}/${quoted}`;
  }

  // -- login / editing ------------------------------------------------------

  async login(username: string, password: string): Promise<{ username: string; rights: string[] }> {
    if (!username || !password) {
      throw new LoginError("ব্যবহারকারীর নাম ও বট পাসওয়ার্ড দুটোই দিন।");
    }
    this.cookies = {};
    this.csrfToken = null;
    await this.init();

    const tokenData = await this.request({
      action: "query",
      meta: "tokens",
      type: "login",
    });
    const loginToken = tokenData.query?.tokens?.logintoken;
    if (!loginToken) {
      throw new LoginError("লগইন টোকেন পাওয়া যায়নি।");
    }
    const data = await this.request(
      {
        action: "login",
        lgname: username,
        lgpassword: password,
        lgtoken: loginToken,
      },
      { method: "POST" },
    );
    const result = data.login ?? {};
    if (result.result !== "Success") {
      const reason = String(result.reason ?? "");
      const reasonLower = reason.toLowerCase();
      const messages: Record<string, string> = {
        WrongPass: "ব্যবহারকারীর নাম বা বট পাসওয়ার্ড ভুল।",
        NotExists: "এই নামে কোনো ব্যবহারকারী নেই।",
        Throttled: "অনেকবার লগইন চেষ্টা হয়েছে; কিছুক্ষণ পরে চেষ্টা করুন।",
        Blocked: "এই অ্যাকাউন্টটি ব্লকড।",
        UserBlocked: "এই অ্যাকাউন্টটি ব্লকড।",
        Aborted: "লগইন বাতিল হয়েছে।",
        NeedToken: "লগইন টোকেন মেলেনি; আবার চেষ্টা করুন।",
        WrongToken: "লগইন টোকেন মেলেনি; আবার চেষ্টা করুন।",
      };
      const message =
        result.result === "FAILED" || reasonLower.includes("incorrect username or password")
          ? "ব্যবহারকারীর নাম বা বট পাসওয়ার্ড ভুল।"
          : messages[String(result.result)] ??
            "লগইন ব্যর্থ হয়েছে। ব্যবহারকারীর নাম ও বট পাসওয়ার্ড পরীক্ষা করুন।";
      throw new LoginError(message, {
        code: String(result.result ?? "login-failed"),
        details: result,
      });
    }

    const userinfoData = await this.request({
      action: "query",
      meta: "userinfo",
      uiprop: "groups|rights",
    });
    const userinfo = userinfoData.query?.userinfo ?? {};
    this.username = String(userinfo.name ?? username);
    this.rights = Array.isArray(userinfo.rights) ? userinfo.rights.map(String) : [];
    return { username: this.username, rights: this.rights };
  }

  async logout(): Promise<void> {
    try {
      const token = await this.csrf();
      await this.request({ action: "logout", token }, { method: "POST" });
    } catch {
      // Best effort.
    }
    this.cookies = {};
    this.csrfToken = null;
  }

  async csrf(force = false): Promise<string> {
    if (this.csrfToken && !force) return this.csrfToken;
    const data = await this.request({
      action: "query",
      meta: "tokens",
      type: "csrf",
    });
    const token = data.query?.tokens?.csrftoken;
    if (!token) throw new WikiError("CSRF টোকেন পাওয়া যায়নি।", { code: "no-token" });
    this.csrfToken = String(token);
    return this.csrfToken;
  }

  async edit(
    title: string,
    text: string,
    summary: string,
    options: { create?: boolean; baserevid?: number | null } = {},
  ): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const params: Record<string, ParamValue> = {
        action: "edit",
        title,
        text,
        summary: summary || "",
        watchlist: "nochange",
        token: await this.csrf(attempt > 0),
        assert: "user",
      };
      if (options.create) {
        params.createonly = 1;
      } else {
        params.nocreate = 1;
        if (options.baserevid) params.baserevid = options.baserevid;
      }
      if (this.rights.includes("bot")) params.bot = 1;
      try {
        const data = await this.request(params, { method: "POST", write: true });
        return data.edit ?? data;
      } catch (error) {
        if (error instanceof TokenError && attempt === 0) continue;
        throw error;
      }
    }
    throw new WikiError("সম্পাদনা করা যায়নি।", { code: "edit-failed" });
  }
}

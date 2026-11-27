"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Analysis,
  PageRecord,
  SaveResponse,
  SearchResult,
  StatusPayload,
} from "@/lib/types";

const DEFAULT_WIKI = "https://bn.wikisource.org";
const RECENT_KEY = "ws-blank-recent-v2";
const SUMMARY_KEY = "ws-blank-summary-v2";
const DEFAULT_SUMMARY = "বট: নির্ঘণ্ট অনুযায়ী লেখাবিহীন পাতা চিহ্নিত করা হলো";
const PAGE_SIZE = 48;
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

const KIND: Record<string, { label: string; cls: string }> = {
  create: { label: "তৈরি হবে", cls: "create" },
  update: { label: "লেভেল ০ হবে", cls: "update" },
  done: { label: "আগেই লেখাবিহীন", cls: "done" },
  conflict: { label: "লেখা আছে", cls: "conflict" },
  redirect: { label: "পুনর্নির্দেশ", cls: "redirect" },
};

const FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "সব" },
  { id: "create", label: "তৈরি হবে" },
  { id: "update", label: "লেভেল ০ হবে" },
  { id: "done", label: "সম্পন্ন" },
  { id: "issue", label: "সমস্যা" },
];

const LOADING_STEPS = [
  ["নির্ঘণ্ট পাতা পড়া হচ্ছে…", "বইয়ের নির্ঘণ্ট ও pagelist বিশ্লেষণ করা হচ্ছে।"],
  ["স্ক্যান ফাইলের পাতা গোনা হচ্ছে…", "PDF/DjVu ফাইলের মোট পাতা ও ছবির ঠিকানা আনা হচ্ছে।"],
  ["বিদ্যমান পাতা পরীক্ষা করা হচ্ছে…", "Page: পাতাগুলোর লেখা ও pagequality লেভেল দেখা হচ্ছে।"],
  ["ফাঁকা পাতার তালিকা সাজানো হচ্ছে…", "শুধু ফাঁকা ও খালি পাতাগুলো আলাদা করা হচ্ছে।"],
];

class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: string,
    data: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function bn(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)]);
}

function isActionable(page: PageRecord | undefined | null): boolean {
  return Boolean(
    page &&
      (page.kind === "create" || page.kind === "update") &&
      !page.outOfRange,
  );
}

function levelLabel(page: PageRecord): string {
  if (page.level === null) return "লেভেল নেই";
  return `লেভেল ${bn(page.level)}${page.levelName ? ` · ${page.levelName}` : ""}`;
}

function shortIndexTitle(title: string): string {
  const index = title.indexOf(":");
  return index >= 0 ? title.slice(index + 1) : title;
}

function pageThumb(base: string | null, number: number, width = 500): string | null {
  if (!base) return null;
  return base.replace(/page\d+-\d+px/, `page${number}-${width}px`);
}

function blankWikitext(username: string): string {
  const safe = username.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<noinclude><pagequality level="0" user="${safe}" /></noinclude>`;
}

function buildWikiSearchUrl(query: string, wiki: string): string {
  let origin = (wiki || DEFAULT_WIKI).trim();
  if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;
  try {
    origin = new URL(origin).origin;
  } catch {
    origin = DEFAULT_WIKI;
  }
  return `${origin}/wiki/Special:Search?search=${encodeURIComponent(query)}&ns102=1`;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string })
    | null;
  if (!response.ok || !data) {
    throw new ApiError(
      data?.error || `অনুরোধ ব্যর্থ হয়েছে (HTTP ${response.status})।`,
      response.status,
      data?.code || "error",
      data ?? {},
    );
  }
  return data as T;
}

async function apiGetStatus(): Promise<StatusPayload> {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error("status failed");
  return (await response.json()) as StatusPayload;
}

function withRecomputedStats(analysis: Analysis, pages: PageRecord[]): Analysis {
  const sorted = [...pages].sort((a, b) => a.num - b.num);
  const count = (kind: string) => sorted.filter((page) => page.kind === kind).length;
  return {
    ...analysis,
    pages: sorted,
    stats: {
      ...analysis.stats,
      create: count("create"),
      update: count("update"),
      done: count("done"),
      conflict: count("conflict"),
      redirect: count("redirect"),
      candidates: sorted.length,
      pending: count("create") + count("update"),
    },
  };
}

export default function Home() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState<Array<{ title: string; wiki: string }>>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewed, setViewed] = useState<Set<number>>(new Set());
  const [dryRun, setDryRun] = useState(true);
  const [viewerNum, setViewerNum] = useState<number | null>(null);
  const [viewerZoom, setViewerZoom] = useState(false);
  const [viewerImage, setViewerImage] = useState("");
  const [viewerImageError, setViewerImageError] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browsePage, setBrowsePage] = useState(0);
  const [browseBusy, setBrowseBusy] = useState<number | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginForm, setLoginForm] = useState({ wiki: DEFAULT_WIKI, username: "", password: "" });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveMode, setSaveMode] = useState<"manual" | "bot">("manual");
  const [saveSummary, setSaveSummary] = useState(DEFAULT_SUMMARY);
  const [saveRunning, setSaveRunning] = useState(false);
  const [saveFinished, setSaveFinished] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ done: 0, total: 0, sub: "" });
  const [saveResults, setSaveResults] = useState<
    Array<{ num: number; type: string; message: string }>
  >([]);
  const [manualDone, setManualDone] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ message: string; tone: string } | null>(null);
  const [search, setSearch] = useState({
    open: false,
    loading: false,
    results: [] as SearchResult[],
    active: -1,
    query: "",
    wiki: DEFAULT_WIKI,
    url: "",
    error: "",
  });
  const [searchFocused, setSearchFocused] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const stopSave = useRef(false);
  const autoAnalyzed = useRef(false);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  const currentWiki = status?.config.wiki || DEFAULT_WIKI;
  const loggedIn = Boolean(status?.loggedIn);

  const pageMap = useMemo(
    () => new Map((analysis?.pages ?? []).map((page) => [page.num, page])),
    [analysis],
  );

  const filteredPages = useMemo(() => {
    if (!analysis) return [];
    if (filter === "all") return analysis.pages;
    if (filter === "issue") {
      return analysis.pages.filter(
        (page) => page.kind === "conflict" || page.kind === "redirect",
      );
    }
    return analysis.pages.filter((page) => page.kind === filter);
  }, [analysis, filter]);

  const selectedPages = useMemo(
    () => (analysis?.pages ?? []).filter((page) => selected.has(page.num)),
    [analysis, selected],
  );

  const viewerPage = viewerNum === null ? null : pageMap.get(viewerNum) ?? null;
  const viewerList = useMemo(() => {
    if (!analysis || viewerNum === null) return [];
    const base = filteredPages.some((page) => page.num === viewerNum)
      ? filteredPages
      : analysis.pages;
    return base.map((page) => page.num);
  }, [analysis, filteredPages, viewerNum]);
  const viewerIndex = viewerNum === null ? -1 : viewerList.indexOf(viewerNum);

  const counts = useMemo(() => {
    const pages = analysis?.pages ?? [];
    return {
      all: pages.length,
      create: pages.filter((page) => page.kind === "create").length,
      update: pages.filter((page) => page.kind === "update").length,
      done: pages.filter((page) => page.kind === "done").length,
      issue: pages.filter(
        (page) => page.kind === "conflict" || page.kind === "redirect",
      ).length,
    };
  }, [analysis]);

  const anyModalOpen =
    viewerNum !== null || browserOpen || loginOpen || saveOpen;

  useEffect(() => {
    document.body.classList.toggle("modal-open", anyModalOpen);
    return () => document.body.classList.remove("modal-open");
  }, [anyModalOpen]);

  useEffect(() => {
    if (!analyzing) return;
    setLoadingStep(0);
    const timer = window.setInterval(
      () => setLoadingStep((step) => (step + 1) % LOADING_STEPS.length),
      2400,
    );
    return () => window.clearInterval(timer);
  }, [analyzing]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (Array.isArray(stored)) setRecent(stored.slice(0, 6));
      const summary = localStorage.getItem(SUMMARY_KEY);
      if (summary) setSaveSummary(summary);
    } catch {
      // ignore
    }
    void (async () => {
      try {
        const payload = await apiGetStatus();
        setStatus(payload);
        setLoginForm((form) => ({ ...form, wiki: payload.config.wiki || DEFAULT_WIKI }));
      } catch {
        setStatus({ loggedIn: false, user: null, wiki: null, config: { wiki: DEFAULT_WIKI } });
      }
    })();
  }, []);

  const showToast = useCallback((message: string, tone = "info") => {
    setToast({ message, tone });
  }, []);

  const rememberRecent = useCallback((title: string, wiki: string) => {
    setRecent((previous) => {
      const next = [
        { title, wiki },
        ...previous.filter((item) => !(item.title === title && item.wiki === wiki)),
      ].slice(0, 6);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const applyAnalysis = useCallback((data: Analysis) => {
    setAnalysis(data);
    setFilter("all");
    setSelected(new Set(data.pages.filter(isActionable).map((page) => page.num)));
    setViewed(new Set());
    setBrowsePage(0);
    setError(null);
    setAnalyzing(false);
    setSaveOpen(false);
    setBrowserOpen(false);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("index", data.index.title);
      url.searchParams.set("wiki", data.wiki.origin);
      window.history.replaceState(null, "", url.toString());
    } catch {
      // ignore
    }
    window.requestAnimationFrame(() => {
      document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const analyze = useCallback(
    async (valueArg?: string, wikiArg?: string) => {
      const value = (valueArg ?? input).trim();
      if (!value) {
        showToast("বই বা নির্ঘণ্টের নাম লিখুন।", "error");
        return;
      }
      setAnalyzing(true);
      setError(null);
      setAnalysis(null);
      setSaveOpen(false);
      setBrowserOpen(false);
      setViewerNum(null);
      try {
        const data = await apiPost<Analysis>("/api/analyze", {
          input: value,
          wiki: wikiArg || currentWiki,
        });
        applyAnalysis(data);
        rememberRecent(data.index.title, data.wiki.origin);
      } catch (problem) {
        setAnalyzing(false);
        if (problem instanceof ApiError) {
          setError({
            message: problem.message,
            suggestions: Array.isArray(problem.data.suggestions)
              ? (problem.data.suggestions as string[])
              : [],
          });
        } else {
          setError({ message: (problem as Error).message, suggestions: [] });
        }
      }
    },
    [applyAnalysis, currentWiki, input, rememberRecent, showToast],
  );

  useEffect(() => {
    if (!status || autoAnalyzed.current) return;
    autoAnalyzed.current = true;
    try {
      const params = new URLSearchParams(window.location.search);
      const index = params.get("index");
      if (index) {
        setInput(index);
        void analyze(index, params.get("wiki") || undefined);
      }
    } catch {
      // ignore
    }
  }, [status, analyze]);

  const runSearch = useCallback(
    async (value: string) => {
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      const wiki = currentWiki;
      setSearch((previous) => ({
        ...previous,
        open: true,
        loading: true,
        results: [],
        active: -1,
        query: value,
        wiki,
        error: "",
      }));
      try {
        const response = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: value, wiki }),
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => null)) as
          | { results?: SearchResult[]; wiki?: string; error?: string; searchUrl?: string }
          | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !data) {
          throw new Error(data?.error || "সার্চ করা যায়নি।");
        }
        setSearch((previous) => ({
          ...previous,
          open: true,
          loading: false,
          results: data.results || [],
          active: -1,
          wiki: data.wiki || wiki,
          url: data.searchUrl || buildWikiSearchUrl(value, data.wiki || wiki),
          error: "",
        }));
      } catch (problem) {
        if (controller.signal.aborted) return;
        setSearch((previous) => ({
          ...previous,
          open: true,
          loading: false,
          results: [],
          active: -1,
          error: (problem as Error).message,
          url: buildWikiSearchUrl(value, wiki),
        }));
      }
    },
    [currentWiki],
  );

  useEffect(() => {
    const value = input.trim();
    if (value.length < 2 || /^https?:\/\//i.test(value)) {
      setSearch((previous) => ({
        ...previous,
        open: false,
        loading: false,
        results: [],
        active: -1,
        error: "",
      }));
      return;
    }
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void runSearch(value);
    }, 280);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [input, runSearch]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!searchBoxRef.current?.contains(event.target as Node)) {
        setSearchFocused(false);
        setSearch((previous) => ({ ...previous, open: false, active: -1 }));
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (viewerNum !== null) {
          setViewerNum(null);
          return;
        }
        if (browserOpen) {
          setBrowserOpen(false);
          return;
        }
        if (loginOpen) {
          setLoginOpen(false);
          return;
        }
        if (saveOpen && !saveRunning) {
          setSaveOpen(false);
        }
        return;
      }
      if (viewerNum !== null && !viewerZoom) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          const next = viewerIndex - 1;
          if (next >= 0) setViewerNum(viewerList[next]);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          const next = viewerIndex + 1;
          if (next < viewerList.length) setViewerNum(viewerList[next]);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    browserOpen,
    loginOpen,
    saveOpen,
    saveRunning,
    viewerIndex,
    viewerList,
    viewerNum,
    viewerZoom,
  ]);

  useEffect(() => {
    if (viewerNum === null) return;
    const page = pageMap.get(viewerNum);
    if (!page) return;
    setViewed((previous) => new Set(previous).add(viewerNum));
    setViewerZoom(false);
    setViewerImageError(false);
    setViewerImage(page.full || page.thumb || "");
  }, [pageMap, viewerNum]);

  function setSelectedNumber(number: number, checked: boolean): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(number);
      else next.delete(number);
      return next;
    });
  }

  function selectAll(): void {
    if (!analysis) return;
    setSelected(new Set(analysis.pages.filter(isActionable).map((page) => page.num)));
  }

  function selectNone(): void {
    setSelected(new Set());
  }

  function openViewer(number: number): void {
    setViewerNum(number);
    setViewerZoom(false);
  }

  async function ensurePageRecord(number: number): Promise<PageRecord> {
    const existing = pageMap.get(number);
    if (existing) return existing;
    if (!analysis) throw new Error("বইটি আগে বিশ্লেষণ করুন।");
    const data = await apiPost<{ page: PageRecord }>("/api/page", {
      origin: analysis.wiki.origin,
      indexTitle: analysis.index.title,
      base: analysis.index.base,
      style: analysis.stats.style,
      pageCount: analysis.index.pagecount,
      thumbBase: analysis.index.thumbBase,
      label: analysis.index.labels[String(number)] ?? null,
      inPagelist: analysis.index.blankPages.includes(number),
      num: number,
    });
    setAnalysis((previous) => {
      if (!previous) return previous;
      const exists = previous.pages.some((page) => page.num === data.page.num);
      const pages = exists
        ? previous.pages.map((page) =>
            page.num === data.page.num ? data.page : page,
          )
        : [...previous.pages, data.page];
      return withRecomputedStats(previous, pages);
    });
    return data.page;
  }

  async function openPage(number: number): Promise<void> {
    setBrowseBusy(number);
    try {
      await ensurePageRecord(number);
      openViewer(number);
    } catch (problem) {
      showToast((problem as Error).message, "error");
    } finally {
      setBrowseBusy(null);
    }
  }

  async function addFromBrowser(number: number): Promise<void> {
    setBrowseBusy(number);
    try {
      const page = await ensurePageRecord(number);
      setFilter("all");
      if (isActionable(page)) {
        const label = String(page.label || "").trim();
        const textualLabel = label.length > 0 && !/^[0-9০-৯]+$/.test(label);
        if (page.kind === "create" && textualLabel) {
          showToast(
            `পৃষ্ঠা ${page.numLabel} তালিকায় যোগ হয়েছে, তবে এর লেবেল “${page.label}” — ` +
              "ফাঁকা কি না দেখে নিশ্চিত হয়ে নির্বাচন করুন।",
          );
          return;
        }
        setSelectedNumber(page.num, true);
        showToast(`পৃষ্ঠা ${page.numLabel} তালিকায় যোগ হয়েছে।`, "success");
        return;
      }
      if (page.kind === "done") showToast("এই পাতাটি আগেই লেখাবিহীন।");
      else if (page.kind === "conflict") {
        showToast("এই পাতায় লেখা আছে; নিরাপত্তার জন্য যোগ করা হলো না।", "error");
      } else if (page.kind === "redirect") {
        showToast("এই পাতাটি একটি পুনর্নির্দেশ; যোগ করা যাবে না।", "error");
      } else {
        showToast("এই পাতাটি এখন যোগ করা যাচ্ছে না।", "error");
      }
    } catch (problem) {
      showToast((problem as Error).message, "error");
    } finally {
      setBrowseBusy(null);
    }
  }

  async function onLoginSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      await apiPost<{ ok: boolean }>("/api/login", loginForm);
      const payload = await apiGetStatus();
      setStatus(payload);
      setLoginOpen(false);
      setLoginError("");
      setLoginForm((form) => ({ ...form, password: "" }));
      setSaveMode("bot");
      showToast("লগইন সফল হয়েছে।", "success");
    } catch (problem) {
      setLoginError((problem as Error).message);
      showToast((problem as Error).message, "error");
    } finally {
      setLoginBusy(false);
    }
  }

  async function onLogout(): Promise<void> {
    try {
      await apiPost<{ ok: boolean }>("/api/logout", {});
      const payload = await apiGetStatus();
      setStatus(payload);
      setSaveMode("manual");
      showToast("লগআউট হয়েছে।");
    } catch (problem) {
      showToast((problem as Error).message, "error");
    }
  }

  function openLogin(): void {
    setLoginForm((form) => ({
      ...form,
      wiki: analysis?.wiki.origin || status?.config.wiki || DEFAULT_WIKI,
      password: "",
    }));
    setLoginError("");
    setLoginOpen(true);
  }

  function openSaveDialog(): void {
    if (!selected.size) {
      showToast("আগে অন্তত একটি পাতা নির্বাচন করুন।", "error");
      return;
    }
    setSaveMode(loggedIn ? "bot" : "manual");
    setSaveFinished(false);
    setSaveResults([]);
    setSaveProgress({ done: 0, total: 0, sub: "" });
    setSaveOpen(true);
    try {
      localStorage.setItem(SUMMARY_KEY, saveSummary || DEFAULT_SUMMARY);
    } catch {
      // ignore
    }
  }

  async function startBotSave(): Promise<void> {
    if (!analysis) return;
    if (!loggedIn) {
      setLoginOpen(true);
      return;
    }
    const pages = selectedPages.filter(isActionable);
    if (!pages.length) {
      showToast("নির্বাচিত কোনো পাতা নেই।", "error");
      return;
    }
    stopSave.current = false;
    setSaveRunning(true);
    setSaveFinished(false);
    setSaveResults([]);
    setSaveProgress({ done: 0, total: pages.length, sub: "শুরু হচ্ছে…" });
    try {
      localStorage.setItem(SUMMARY_KEY, saveSummary || DEFAULT_SUMMARY);
    } catch {
      // ignore
    }

    for (const page of pages) {
      if (stopSave.current) break;
      setSaveProgress((previous) => ({
        ...previous,
        sub: `পৃষ্ঠা ${page.numLabel} প্রক্রিয়া করা হচ্ছে…`,
      }));
      try {
        const result = await apiPost<SaveResponse>("/api/save", {
          origin: analysis.wiki.origin,
          indexTitle: analysis.index.title,
          pageTitle: page.title,
          num: page.num,
          dryRun,
          summary: saveSummary,
        });
        setSaveResults((previous) => [
          ...previous,
          {
            num: page.num,
            type:
              result.status === "saved" || result.status === "already_done"
                ? "saved"
                : result.status === "dry_run"
                  ? "dry"
                  : result.status === "skipped"
                    ? "skipped"
                    : "error",
            message: result.message,
          },
        ]);
        if (result.status === "saved" || result.status === "already_done") {
          setSelected((previous) => {
            const next = new Set(previous);
            next.delete(page.num);
            return next;
          });
          setAnalysis((previous) => {
            if (!previous) return previous;
            const pages = previous.pages.map((item) =>
              item.num === page.num
                ? {
                    ...item,
                    kind: "done" as const,
                    level: 0,
                    levelName: "লেখাবিহীন",
                    hasText: false,
                    excerpt: "",
                  }
                : item,
            );
            return withRecomputedStats(previous, pages);
          });
        } else if (result.status === "skipped") {
          setSelected((previous) => {
            const next = new Set(previous);
            next.delete(page.num);
            return next;
          });
          if (result.excerpt) {
            setAnalysis((previous) => {
              if (!previous) return previous;
              const pages = previous.pages.map((item) =>
                item.num === page.num
                  ? {
                      ...item,
                      kind: "conflict" as const,
                      hasText: true,
                      excerpt: result.excerpt || "",
                    }
                  : item,
              );
              return withRecomputedStats(previous, pages);
            });
          }
        }
      } catch (problem) {
        const message = (problem as Error).message;
        setSaveResults((previous) => [
          ...previous,
          { num: page.num, type: "error", message },
        ]);
        if (problem instanceof ApiError && problem.status === 401) {
          stopSave.current = true;
        }
      }
      setSaveProgress((previous) => ({ ...previous, done: previous.done + 1 }));
    }

    setSaveRunning(false);
    setSaveFinished(true);
  }

  function stopBotSave(): void {
    stopSave.current = true;
    setSaveProgress((previous) => ({ ...previous, sub: "থামানোর অনুরোধ…" }));
  }

  async function copyBlankPage(): Promise<void> {
    const text = blankWikitext(status?.user || "");
    try {
      await navigator.clipboard.writeText(text);
      showToast("লেখাবিহীন টেমপ্লেট কপি হয়েছে।", "success");
    } catch {
      showToast("কপি করা যায়নি; ম্যানুয়ালি কপি করুন।", "error");
    }
  }

  function nextManualPage(): void {
    const next = selectedPages.find((page) => !manualDone.has(page.num));
    if (!next) {
      showToast("সব নির্বাচিত পাতা খোলা হয়েছে।", "success");
      return;
    }
    window.open(next.url, "_blank", "noopener,noreferrer");
  }

  function toggleManualDone(number: number): void {
    setManualDone((previous) => {
      const next = new Set(previous);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  function chooseSearchResult(index: number): void {
    const result = search.results[index];
    if (!result) return;
    setInput(result.title);
    setSearch((previous) => ({ ...previous, open: false, active: -1 }));
    setSearchFocused(false);
    void analyze(result.title, search.wiki || currentWiki);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape" && search.open) {
      setSearch((previous) => ({ ...previous, open: false, active: -1 }));
      return;
    }
    if (!search.open || !search.results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = (search.active + 1) % search.results.length;
      setSearch((previous) => ({ ...previous, active: next }));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = (search.active - 1 + search.results.length) % search.results.length;
      setSearch((previous) => ({ ...previous, active: next }));
    } else if (event.key === "Enter" && search.active >= 0) {
      event.preventDefault();
      chooseSearchResult(search.active);
    }
  }

  const totalPages = analysis?.index.pagecount ?? 0;
  const browseMaxPage = Math.max(0, Math.ceil(totalPages / PAGE_SIZE) - 1);
  const browseStart = browsePage * PAGE_SIZE + 1;
  const browseEnd = Math.min(totalPages, (browsePage + 1) * PAGE_SIZE);
  const progressTotal = analysis
    ? analysis.stats.done +
      analysis.stats.pending +
      analysis.stats.conflict +
      analysis.stats.redirect
    : 0;
  const progressPercent = progressTotal
    ? Math.round((analysis!.stats.done / progressTotal) * 100)
    : 0;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label="ফাঁকা পাতা — শুরুতে ফিরুন">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
                <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" />
                <path d="M8.5 7.5h6" />
              </svg>
            </span>
            <span className="brand-text">
              <strong>ফাঁকা পাতা</strong>
              <small>উইকিসংকলন প্রুফরিডিং সহায়ক</small>
            </span>
          </a>
          <div className="top-actions">
            <button
              className={`status-chip ${loggedIn ? "is-online" : ""}`}
              type="button"
              onClick={openLogin}
            >
              <span className="status-dot" />
              <span>{loggedIn ? status?.user : "লগইন করুন"}</span>
            </button>
            <button className="icon-button" type="button" onClick={openLogin} aria-label="সেটিংস">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.15.36.37.7.66 1 .3.28.68.42 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6Z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="shell">
        <section className="hero panel">
          <div className="hero-decor" aria-hidden="true" />
          <div className="hero-copy">
            <span className="eyebrow">ধাপ ১ · বই বেছে নিন</span>
            <h1>
              কোন বইয়ের <em>ফাঁকা পাতা</em> দেখতে চান?
            </h1>
            <p>
              নির্ঘণ্ট পাতার নাম, ফাইলের নাম বা সরাসরি লিংক দিন — নাম লিখতে শুরু করলেই
              উইকিসংকলন থেকে নির্ঘণ্টের সাজেশন আসবে। টুলটি শুধু ফাঁকা ও খালি
              পাতাগুলো খুঁজে এনে স্ক্যানসহ দেখাবে — আপনি চোখে যাচাই করে একসাথে
              <strong> “লেখাবিহীন”</strong> হিসেবে চিহ্নিত করতে পারবেন।
            </p>
          </div>

          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch((previous) => ({ ...previous, open: false }));
              void analyze();
            }}
          >
            <div className="search-field" ref={searchBoxRef}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.6-3.6" />
              </svg>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onKeyDown={onSearchKeyDown}
                placeholder="যেমন: আলো - জগদানন্দ রায় (১৯২৬).pdf"
                spellCheck={false}
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls="search-pop"
                aria-expanded={search.open}
              />
              {search.open && searchFocused ? (
                <div className="search-pop" id="search-pop" role="listbox">
                  {search.loading ? (
                    <div className="search-loading">
                      <span className="mini-spinner" /> উইকিসংকলনে খোঁজা হচ্ছে…
                    </div>
                  ) : search.error ? (
                    <div className="search-pop-empty">
                      সার্চ করা যায়নি: {search.error}
                      <br />
                      <a href={search.url || buildWikiSearchUrl(input, currentWiki)} target="_blank" rel="noopener noreferrer">
                        উইকিসংকলনে সরাসরি সার্চ করুন ↗
                      </a>
                    </div>
                  ) : search.results.length ? (
                    <>
                      <div className="search-pop-label">উইকিসংকলনের নির্ঘণ্ট</div>
                      {search.results.map((result, index) => (
                        <button
                          key={result.title}
                          type="button"
                          className={`search-result ${index === search.active ? "is-active" : ""}`}
                          role="option"
                          aria-selected={index === search.active}
                          onClick={() => chooseSearchResult(index)}
                        >
                          <span className="search-result-title">{shortIndexTitle(result.title)}</span>
                          {result.snippet ? (
                            <span className="search-result-snippet">{result.snippet}</span>
                          ) : (
                            <span className="search-result-source">বইয়ের নির্ঘণ্ট পাতা</span>
                          )}
                        </button>
                      ))}
                      <div className="search-pop-foot">
                        <span>{bn(search.results.length)}টি ফলাফল</span>
                        <a href={search.url || buildWikiSearchUrl(input, search.wiki)} target="_blank" rel="noopener noreferrer">
                          সব ফলাফল ↗
                        </a>
                      </div>
                    </>
                  ) : (
                    <div className="search-pop-empty">
                      “{search.query}” — কোনো নির্ঘণ্ট পাতা পাওয়া যায়নি।
                      <br />
                      <a href={search.url || buildWikiSearchUrl(input, currentWiki)} target="_blank" rel="noopener noreferrer">
                        উইকিসংকলনে সার্চ করুন ↗
                      </a>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <button type="submit" className="button primary" disabled={analyzing}>
              <span>{analyzing ? "বিশ্লেষণ হচ্ছে…" : "বিশ্লেষণ করুন"}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>

          <div className="search-foot">
            <div className="examples">
              <span className="muted">উদাহরণ:</span>
              <button
                type="button"
                className="example-chip"
                onClick={() => {
                  setInput("আলো - জগদানন্দ রায় (১৯২৬).pdf");
                  void analyze("আলো - জগদানন্দ রায় (১৯২৬).pdf");
                }}
              >
                আলো — জগদানন্দ রায়
              </button>
              <button
                type="button"
                className="link-button"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text.trim()) setInput(text.trim());
                  } catch {
                    showToast("ক্লিপবোর্ড পড়া যায়নি; ম্যানুয়ালি পেস্ট করুন।", "error");
                  }
                }}
              >
                ক্লিপবোর্ড থেকে লিংক নিন
              </button>
            </div>
            {recent.length ? (
              <div className="recent">
                <span>সাম্প্রতিক:</span>
                {recent.map((item) => (
                  <button
                    key={`${item.wiki}:${item.title}`}
                    type="button"
                    className="recent-chip"
                    title={item.title}
                    onClick={() => {
                      setInput(item.title);
                      void analyze(item.title, item.wiki);
                    }}
                  >
                    {shortIndexTitle(item.title)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        {analyzing ? (
          <section className="panel loading" aria-live="polite">
            <div className="spinner" aria-hidden="true" />
            <div className="loading-copy">
              <h2>{LOADING_STEPS[loadingStep][0]}</h2>
              <p>{LOADING_STEPS[loadingStep][1]}</p>
              <div className="indeterminate">
                <span />
              </div>
            </div>
          </section>
        ) : null}

        {error && !analyzing ? (
          <section className="panel message-panel error-panel">
            <div className="message-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5v5.5M12 16.5v.01" />
              </svg>
            </div>
            <div className="message-copy">
              <h2>বিশ্লেষণ করা যায়নি</h2>
              <p>{error.message}</p>
              {error.suggestions.length ? (
                <div className="suggestions">
                  {error.suggestions.map((title) => (
                    <button
                      key={title}
                      type="button"
                      className="suggestion-chip"
                      onClick={() => {
                        setInput(title);
                        void analyze(title, currentWiki);
                      }}
                    >
                      {title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {analysis ? (
          <section id="results">
            <div className="book-card panel">
              <div className="book-card-main">
                <span className="book-cover" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
                    <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" />
                  </svg>
                </span>
                <div className="book-card-copy">
                  <span className="eyebrow">বিশ্লেষণ সম্পন্ন</span>
                  <h2>{analysis.index.title}</h2>
                  <div className="book-meta">
                    <a href={analysis.index.url} target="_blank" rel="noopener noreferrer">
                      নির্ঘণ্ট পাতা ↗
                    </a>
                    <a href={analysis.index.filePageUrl} target="_blank" rel="noopener noreferrer">
                      স্ক্যান ফাইল ↗
                    </a>
                    <span>
                      মোট {bn(analysis.index.pagecount)}টি স্ক্যান পাতা
                      {analysis.stats.textPages
                        ? ` · ${bn(analysis.stats.textPages)}টি বিদ্যমান পাতা লেখাসহ বাদ`
                        : ""}
                    </span>
                  </div>
                </div>
              </div>
              <div className="book-progress">
                <div className="book-progress-head">
                  <span>ফাঁকা পাতার অগ্রগতি</span>
                  <strong>
                    {bn(analysis.stats.done)} / {bn(progressTotal)} সম্পন্ন
                  </strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progressPercent}%` }} />
                </div>
                <small>
                  {progressTotal === 0
                    ? "এই বইয়ে কোনো ফাঁকা পাতা পাওয়া যায়নি।"
                    : analysis.stats.pending
                      ? `${bn(analysis.stats.pending)}টি পাতা এখনো বাকি।`
                      : analysis.stats.conflict || analysis.stats.redirect
                        ? `${bn(analysis.stats.conflict + analysis.stats.redirect)}টি পাতা হাতে দেখতে হবে।`
                        : "সব ফাঁকা পাতা লেখাবিহীন হিসেবে চিহ্নিত।"}
                </small>
              </div>
            </div>

            <div className="stats">
              {[
                { label: "মোট স্ক্যান", value: analysis.stats.pagecount, tone: "neutral" },
                { label: "ফাঁকা চিহ্নিত", value: analysis.stats.markedBlank, tone: "accent", note: "pagelist অনুযায়ী" },
                { label: "তৈরি হবে", value: analysis.stats.create, tone: "create" },
                { label: "লেভেল ০ হবে", value: analysis.stats.update, tone: "update" },
                { label: "আগেই লেখাবিহীন", value: analysis.stats.done, tone: "done" },
                { label: "লেখা আছে", value: analysis.stats.conflict, tone: "conflict", note: "বাদ দেওয়া হয়েছে" },
              ].map((tile) => (
                <div key={tile.label} className={`stat tone-${tile.tone}`}>
                  <strong>{bn(tile.value)}</strong>
                  <span>{tile.label}</span>
                  {tile.note ? <small>{tile.note}</small> : null}
                </div>
              ))}
            </div>

            {analysis.warnings.length ? (
              <div className="warnings">
                <ul>
                  {analysis.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="toolbar panel">
              <div className="toolbar-top">
                <div>
                  <span className="eyebrow">ধাপ ২ · যাচাই করুন</span>
                  <h3>ফাঁকা পাতার তালিকা</h3>
                  <p className="muted">
                    {bn(filteredPages.length)}টি দেখানো হচ্ছে
                    {analysis.stats.markedBlank
                      ? ` · ${bn(analysis.stats.markedBlank)}টি pagelist-এ ফাঁকা চিহ্নিত`
                      : ""}
                    {analysis.stats.textPages
                      ? ` · ${bn(analysis.stats.textPages)}টি লেখাসহ বাদ`
                      : ""}
                  </p>
                </div>
                <div className="selection-tools">
                  <button type="button" className="link-button with-icon" onClick={() => setBrowserOpen(true)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="3" width="7" height="7" rx="1.4" />
                      <rect x="14" y="3" width="7" height="7" rx="1.4" />
                      <rect x="3" y="14" width="7" height="7" rx="1.4" />
                      <rect x="14" y="14" width="7" height="7" rx="1.4" />
                    </svg>
                    সব স্ক্যান পাতা
                  </button>
                  <span className="dot-sep">·</span>
                  <button type="button" className="link-button" onClick={selectAll}>
                    সব নির্বাচন
                  </button>
                  <span className="dot-sep">·</span>
                  <button type="button" className="link-button" onClick={selectNone}>
                    নির্বাচন বাতিল
                  </button>
                </div>
              </div>
              <div className="filters" role="tablist" aria-label="তালিকা ফিল্টার">
                {FILTERS.map((item) => {
                  const count = counts[item.id as keyof typeof counts] || 0;
                  const active = filter === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`filter ${active ? "is-active" : ""}`}
                      role="tab"
                      aria-selected={active}
                      onClick={() => setFilter(item.id)}
                    >
                      {item.label}
                      <span className="count">{bn(count)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {filteredPages.length ? (
              <div className="gallery">
                {filteredPages.map((page) => {
                  const meta = KIND[page.kind] || KIND.create;
                  const selectable = isActionable(page);
                  const isSelected = selected.has(page.num);
                  const isViewed = viewed.has(page.num);
                  return (
                    <article
                      key={page.num}
                      className={`page-card kind-${page.kind} ${isSelected ? "is-selected" : ""}`}
                      data-num={page.num}
                      title={page.title}
                      tabIndex={0}
                      aria-label={`স্ক্যান পৃষ্ঠা ${page.numLabel} — ${meta.label}`}
                      onClick={() => openViewer(page.num)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openViewer(page.num);
                        }
                      }}
                    >
                      <div className="thumb-wrap">
                        <button
                          type="button"
                          className="thumb-button"
                          aria-label={`পৃষ্ঠা ${page.numLabel} বড় করে দেখুন`}
                        >
                          {page.thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={page.thumb}
                              alt={`স্ক্যান পৃষ্ঠা ${page.numLabel}`}
                              loading="lazy"
                              decoding="async"
                              referrerPolicy="no-referrer"
                              onError={(event) => {
                                event.currentTarget.classList.add("broken");
                                event.currentTarget.parentElement?.parentElement?.classList.add("img-broken");
                              }}
                            />
                          ) : (
                            <span className="no-thumb">স্ক্যানের ছবি নেই</span>
                          )}
                        </button>
                        <span className="num-badge">পৃষ্ঠা {page.numLabel}</span>
                        {selectable ? (
                          <label
                            className="pick"
                            title="নির্বাচন করুন"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              aria-label={`পৃষ্ঠা ${page.numLabel} নির্বাচন করুন`}
                              onChange={(event) => setSelectedNumber(page.num, event.target.checked)}
                            />
                            <span aria-hidden="true" />
                          </label>
                        ) : (
                          <span className="lock-badge" title="এই পাতাটি স্বয়ংক্রিয়ভাবে বদলানো যাবে না">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="5" y="10" width="14" height="10" rx="2" />
                              <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
                            </svg>
                          </span>
                        )}
                        {isViewed ? (
                          <span className="viewed-badge">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M2.5 12s3.5-5.5 9.5-5.5S21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
                              <circle cx="12" cy="12" r="2.4" />
                            </svg>
                            দেখা হয়েছে
                          </span>
                        ) : null}
                      </div>
                      <div className="card-body">
                        <div className="status-line">
                          <span className={`badge ${meta.cls}`}>{meta.label}</span>
                          <span className="level-chip">{levelLabel(page)}</span>
                        </div>
                        {page.label ? <span className="page-label">{page.label}</span> : null}
                        {page.manual ? <span className="manual-note">হাতে যোগ করা</span> : null}
                        <a
                          className="page-title"
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          title={page.title}
                        >
                          {page.title}
                        </a>
                        {page.hasText && page.excerpt ? <p className="excerpt">{page.excerpt}</p> : null}
                        {page.otherTitles.length ? (
                          <div className="dup-note">
                            একই পাতার আরও:{" "}
                            {page.otherTitles
                              .map((title) => title.split("/").pop())
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        ) : null}
                        {page.outOfRange ? <div className="range-note">স্ক্যানের মোট পাতার বাইরে</div> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="panel empty-state">
                <div className="empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
                    <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" />
                    <path d="M9 9h6M9 12.5h4" />
                  </svg>
                </div>
                <h3>{filter === "all" ? "এই বইয়ে কোনো ফাঁকা পাতা পাওয়া যায়নি" : "এই তালিকায় কোনো পাতা নেই"}</h3>
                <p>
                  {filter === "all"
                    ? "pagelist-এ কোনো ফাঁকা চিহ্ন নেই এবং বিদ্যমান খালি পাতাও পাওয়া যায়নি।"
                    : "অন্য ফিল্টার বেছে নিন বা সব পাতা দেখুন।"}
                </p>
                {filter !== "all" ? (
                  <button type="button" className="button ghost" onClick={() => setFilter("all")}>
                    সব পাতা দেখুন
                  </button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}
      </main>

      <footer className="footer">
        <p>
          বট পাসওয়ার্ড শুধু লগইনের সময় ব্যবহৃত হয়; সার্ভারে সংরক্ষণ করা হয় না।
          প্রত্যেক ব্যবহারকারীর সেশন আলাদা এবং এনক্রিপ্টেড কুকিতে সুরক্ষিত।
        </p>
        <p className="footer-sub">উইকিসংকলনের জন্য একটি ছোট প্রুফরিডিং সহায়ক · v2.0 (Next.js)</p>
      </footer>

      {analysis ? (
        <div className="save-bar">
          <div className="save-bar-inner">
            <div className="save-info">
              <strong>
                {selected.size
                  ? `${bn(selected.size)}টি পাতা নির্বাচিত`
                  : "কোনো পাতা নির্বাচিত নেই"}
              </strong>
              <span>
                {loggedIn
                  ? "বট সেশন দিয়ে একসাথে লেখাবিহীন হিসেবে চিহ্নিত করা যাবে"
                  : "বট পাসওয়ার্ড ছাড়া এক-পাতা-করে উইকিসংকলনে সম্পাদনা করুন"}
              </span>
            </div>
            {loggedIn ? (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(event) => setDryRun(event.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
                <span className="switch-label">পরীক্ষা মোড</span>
              </label>
            ) : null}
            <button
              type="button"
              className="button primary"
              disabled={!selected.size}
              onClick={openSaveDialog}
            >
              {loggedIn ? (dryRun ? "যাচাই করুন" : "প্রুফ করুন") : "ম্যানুয়াল প্রুফ"}
            </button>
          </div>
        </div>
      ) : null}

      {viewerPage ? (
        <div
          className="modal viewer"
          onClick={(event) => {
            if (event.target === event.currentTarget) setViewerNum(null);
          }}
        >
          <div className="viewer-dialog" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
            <header className="viewer-head">
              <div className="viewer-heading">
                <span className="viewer-kicker">স্ক্যান পাতা</span>
                <h2 id="viewer-title">{viewerPage.title}</h2>
              </div>
              <div className="viewer-head-actions">
                <span className={`badge ${(KIND[viewerPage.kind] || KIND.create).cls}`}>
                  {(KIND[viewerPage.kind] || KIND.create).label}
                </span>
                <button type="button" className="icon-button on-dark" onClick={() => setViewerNum(null)} aria-label="বন্ধ করুন">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="m6 6 12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            </header>
            <div className="viewer-stage">
              <button
                type="button"
                className="nav-button prev"
                aria-label="আগের পাতা"
                disabled={viewerIndex <= 0}
                onClick={() => {
                  const previous = viewerList[viewerIndex - 1];
                  if (previous !== undefined) setViewerNum(previous);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 5-7 7 7 7" />
                </svg>
              </button>
              <div className={`viewer-image-wrap ${viewerZoom ? "zoomed" : ""}`}>
                {viewerImage && !viewerImageError ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={viewerImage}
                    alt={`স্ক্যান পৃষ্ঠা ${viewerPage.numLabel}`}
                    onClick={() => setViewerZoom((value) => !value)}
                    onError={() => {
                      if (viewerPage.thumb && viewerImage !== viewerPage.thumb) {
                        setViewerImage(viewerPage.thumb);
                      } else {
                        setViewerImageError(true);
                      }
                    }}
                  />
                ) : (
                  <div className="viewer-img-error">স্ক্যানের ছবি আনা যায়নি।</div>
                )}
              </div>
              <button
                type="button"
                className="nav-button next"
                aria-label="পরের পাতা"
                disabled={viewerIndex < 0 || viewerIndex >= viewerList.length - 1}
                onClick={() => {
                  const next = viewerList[viewerIndex + 1];
                  if (next !== undefined) setViewerNum(next);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 5 7 7-7 7" />
                </svg>
              </button>
            </div>
            <footer className="viewer-foot">
              <div className="viewer-meta">
                <span>{levelLabel(viewerPage)}</span>
                {viewerPage.label ? <span>লেবেল: {viewerPage.label}</span> : null}
                <span>
                  {bn(viewerIndex + 1)} / {bn(viewerList.length)}
                </span>
              </div>
              <div className="viewer-links">
                <a href={viewerPage.url} target="_blank" rel="noopener noreferrer">
                  উইকিসংকলনে খুলুন ↗
                </a>
                <button type="button" className="button small ghost" onClick={copyBlankPage}>
                  লেখাবিহীন কপি
                </button>
                {isActionable(viewerPage) ? (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => setSelectedNumber(viewerPage.num, !selected.has(viewerPage.num))}
                  >
                    {selected.has(viewerPage.num) ? "নির্বাচন বাতিল" : "নির্বাচন করুন"}
                  </button>
                ) : (
                  <button type="button" className="button small" disabled>
                    {viewerPage.kind === "done" ? "আগেই লেখাবিহীন" : "নির্বাচনযোগ্য নয়"}
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      {browserOpen && analysis ? (
        <div
          className="modal browser"
          onClick={(event) => {
            if (event.target === event.currentTarget) setBrowserOpen(false);
          }}
        >
          <div className="modal-dialog browser-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-title">
            <header className="dialog-head">
              <div>
                <span className="eyebrow">স্ক্যান ব্রাউজার</span>
                <h2 id="browser-title">বইয়ের সব পাতা</h2>
                <p className="muted">
                  মোট {bn(totalPages)}টি স্ক্যান পাতা · যেকোনো পাতা দেখে ফাঁকা হলে তালিকায় যোগ করুন
                </p>
              </div>
              <button type="button" className="icon-button" onClick={() => setBrowserOpen(false)} aria-label="বন্ধ করুন">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </header>
            <div className="browser-toolbar">
              <div className="browser-pager">
                <button
                  type="button"
                  className="button small ghost"
                  disabled={browsePage <= 0}
                  onClick={() => setBrowsePage((page) => Math.max(0, page - 1))}
                >
                  আগের
                </button>
                <span className="muted">
                  পৃষ্ঠা {bn(browseStart)}–{bn(browseEnd)} / {bn(totalPages)}
                </span>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={browsePage >= browseMaxPage}
                  onClick={() => setBrowsePage((page) => Math.min(browseMaxPage, page + 1))}
                >
                  পরের
                </button>
              </div>
              <form
                className="browser-jump"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = Number.parseInt(
                    (event.currentTarget.elements.namedItem("jump") as HTMLInputElement)?.value ?? "",
                    10,
                  );
                  if (!Number.isFinite(value) || value < 1 || value > totalPages) {
                    showToast("সঠিক পৃষ্ঠা নম্বর দিন।", "error");
                    return;
                  }
                  setBrowsePage(Math.floor((value - 1) / PAGE_SIZE));
                }}
              >
                <label htmlFor="browser-jump">পৃষ্ঠায় যান</label>
                <input id="browser-jump" name="jump" type="number" min={1} max={totalPages} inputMode="numeric" />
                <button type="submit" className="button small">
                  যান
                </button>
              </form>
            </div>
            <div className="browser-grid">
              {Array.from({ length: Math.max(0, browseEnd - browseStart + 1) }, (_, index) => {
                const number = browseStart + index;
                const page = pageMap.get(number);
                const meta = page ? KIND[page.kind] || KIND.create : null;
                const thumb = pageThumb(analysis.index.thumbBase, number) || page?.thumb || null;
                const numeral =
                  page?.numLabel || (analysis.stats.style === "bn" ? bn(number) : String(number));
                const isSelected = selected.has(number);
                const busy = browseBusy === number;
                const knownLabel =
                  page?.label || analysis.index.labels[String(number)] || null;
                return (
                  <article
                    key={number}
                    className={`browse-item ${isSelected ? "is-selected" : ""}`}
                    data-num={number}
                    title={page?.title || `স্ক্যান পৃষ্ঠা ${numeral}`}
                  >
                    <div
                      className="browse-thumb"
                      role="button"
                      tabIndex={0}
                      aria-label={`পৃষ্ঠা ${numeral} বড় করে দেখুন`}
                      onClick={() => void openPage(number)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void openPage(number);
                        }
                      }}
                    >
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb}
                          alt={`স্ক্যান পৃষ্ঠা ${numeral}`}
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                          onError={(event) => {
                            event.currentTarget.classList.add("broken");
                            event.currentTarget.parentElement?.classList.add("img-broken");
                          }}
                        />
                      ) : (
                        <span className="no-thumb">স্ক্যানের ছবি নেই</span>
                      )}
                      <span className="num-badge">পৃষ্ঠা {numeral}</span>
                      <span className="browse-kind">
                        {meta ? (
                          <span className={`badge ${meta.cls}`}>{meta.label}</span>
                        ) : (
                          <span className="badge unknown">যাচাই বাকি</span>
                        )}
                      </span>
                    </div>
                    <div className="browse-body">
                      {knownLabel ? <span className="browse-label">{knownLabel}</span> : null}
                      <div className="browse-actions">
                        {page && isActionable(page) ? (
                          <button
                            type="button"
                            className={`button small ${isSelected ? "ghost" : "primary"}`}
                            disabled={busy}
                            onClick={() => setSelectedNumber(number, !selected.has(number))}
                          >
                            {isSelected ? "বাদ দিন" : "নির্বাচন"}
                          </button>
                        ) : page ? (
                          <span className="muted">
                            {page.kind === "done"
                              ? "আগেই লেখাবিহীন"
                              : page.kind === "conflict"
                                ? "লেখা আছে"
                                : "তালিকায় আছে"}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="button small ghost"
                            disabled={busy}
                            onClick={() => void addFromBrowser(number)}
                          >
                            {busy ? "দেখা হচ্ছে…" : "যোগ করুন"}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <footer className="browser-foot">
              <p>
                স্ক্যান দেখে ফাঁকা মনে হলে “যোগ করুন” চাপুন। উইকির Page: পাতায় লেখা থাকলে
                টুল সেটি যোগ করবে না; শুধু স্ক্যানে লেখা থাকলে নিজে দেখে নিশ্চিত হন।
              </p>
            </footer>
          </div>
        </div>
      ) : null}

      {loginOpen ? (
        <div
          className="modal login"
          onClick={(event) => {
            if (event.target === event.currentTarget) setLoginOpen(false);
          }}
        >
          <div className="modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
            <header className="dialog-head">
              <div>
                <span className="eyebrow">সংযোগ</span>
                <h2 id="login-title">লগইন ও সেটিংস</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setLoginOpen(false)} aria-label="বন্ধ করুন">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </header>
            <div className={`settings-status${loggedIn ? " is-online" : ""}${loginError ? " is-error" : ""}`}>
              {loggedIn ? (
                <>সংযুক্ত: <strong>{status?.user}</strong> · {status?.wiki}</>
              ) : loginError ? (
                loginError
              ) : (
                "লগইন নেই — পড়া ও যাচাই লগইন ছাড়াও চলবে; একসাথে সেভ করতে বট পাসওয়ার্ড দিয়ে লগইন করুন।"
              )}
            </div>
            <form className="settings-form" onSubmit={(event) => void onLoginSubmit(event)}>
              <label className="field">
                <span>উইকি</span>
                <input
                  type="text"
                  value={loginForm.wiki}
                  onChange={(event) => setLoginForm((form) => ({ ...form, wiki: event.target.value }))}
                  placeholder="https://bn.wikisource.org"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>ব্যবহারকারীর নাম</span>
                <input
                  type="text"
                  value={loginForm.username}
                  onChange={(event) => setLoginForm((form) => ({ ...form, username: event.target.value }))}
                  placeholder="ব্যবহারকারী@বট"
                  autoComplete="username"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>বট পাসওয়ার্ড</span>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(event) => setLoginForm((form) => ({ ...form, password: event.target.value }))}
                  autoComplete="current-password"
                />
              </label>
              <p className="help">
                বট পাসওয়ার্ডের লগইন নাম সাধারণত <code>ব্যবহারকারী@বটনাম</code> হয়। সাধারণ
                অ্যাকাউন্ট পাসওয়ার্ড নয় — <strong>Special:BotPasswords</strong> থেকে তৈরি
                আলাদা পাসওয়ার্ড ব্যবহার করুন। পাসওয়ার্ড সার্ভারে সংরক্ষণ করা হয় না।
                বাল্ক সম্পাদনার জন্য অনুমোদিত বট অ্যাকাউন্ট ব্যবহার করুন; সাধারণ
                অ্যাকাউন্টে স্বয়ংক্রিয়/বাল্ক সম্পাদনা করলে উইকির বট নীতিতে ব্লক হতে পারে।
              </p>
              <div className="form-actions">
                <a
                  className="link"
                  href={`${loginForm.wiki || DEFAULT_WIKI}/wiki/Special:BotPasswords`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  বট পাসওয়ার্ড তৈরি করুন ↗
                </a>
                <button type="submit" className="button primary" disabled={loginBusy}>
                  {loginBusy ? "লগইন হচ্ছে…" : "লগইন করুন"}
                </button>
              </div>
            </form>
            <div className="settings-footer">
              {loggedIn ? (
                <button type="button" className="button ghost danger" onClick={() => void onLogout()}>
                  লগআউট
                </button>
              ) : (
                <span />
              )}
              <span className="muted">প্রত্যেক ব্যবহারকারীর সেশন আলাদা · ৮ ঘণ্টা</span>
            </div>
          </div>
        </div>
      ) : null}

      {saveOpen && analysis ? (
        <div
          className="modal"
          onClick={(event) => {
            if (event.target === event.currentTarget && !saveRunning) setSaveOpen(false);
          }}
        >
          <div className="modal-dialog save-dialog" role="dialog" aria-modal="true" aria-labelledby="save-title">
            <header className="dialog-head">
              <div>
                <span className="eyebrow">ধাপ ৩ · নিশ্চিত করুন</span>
                <h2 id="save-title">লেখাবিহীন হিসেবে প্রুফ</h2>
                <p className="muted">
                  {bn(selectedPages.length)}টি পাতা নির্বাচিত
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  if (!saveRunning) setSaveOpen(false);
                }}
                aria-label="বন্ধ করুন"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </header>

            <div className="mode-tabs" role="tablist">
              <button
                type="button"
                className={`mode-tab ${saveMode === "manual" ? "is-active" : ""}`}
                onClick={() => setSaveMode("manual")}
                disabled={saveRunning}
              >
                ম্যানুয়াল (পাবলিক)
              </button>
              <button
                type="button"
                className={`mode-tab ${saveMode === "bot" ? "is-active" : ""}`}
                onClick={() => {
                  setSaveMode("bot");
                  if (!loggedIn) setLoginOpen(true);
                }}
                disabled={saveRunning}
              >
                বট দিয়ে সেভ
              </button>
            </div>

            {saveMode === "manual" ? (
              <div className="save-manual">
                <div className="notice is-info">
                  বট পাসওয়ার্ড ছাড়া একসাথে সেভ হবে না। নিচের প্রতিটি পাতা উইকিসংকলনে খুলে
                  <strong> “লেখাবিহীন”</strong> নির্বাচন করে সেভ করুন। ডান দিকের “কপি” চাপলে
                  প্রয়োজনীয় উইকিটেক্সট ক্লিপবোর্ডে যাবে।
                </div>
                <div className="manual-list">
                  {selectedPages.map((page) => (
                    <div key={page.num} className="manual-row">
                      <label className="manual-done">
                        <input
                          type="checkbox"
                          checked={manualDone.has(page.num)}
                          onChange={() => toggleManualDone(page.num)}
                        />
                        <span>পৃষ্ঠা {page.numLabel}</span>
                      </label>
                      <span className="manual-title" title={page.title}>
                        {page.title}
                      </span>
                      <div className="manual-actions">
                        <a href={page.url} target="_blank" rel="noopener noreferrer" className="button small ghost">
                          খুলুন ↗
                        </a>
                        <button type="button" className="button small ghost" onClick={() => void copyBlankPage()}>
                          কপি
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="save-actions">
                  <button type="button" className="button ghost" onClick={() => setSaveOpen(false)}>
                    বন্ধ
                  </button>
                  <button type="button" className="button primary" onClick={nextManualPage}>
                    পরবর্তী পাতা খুলুন
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      setSaveMode("bot");
                      setLoginOpen(true);
                    }}
                  >
                    লগইন করে একসাথে সেভ
                  </button>
                </div>
              </div>
            ) : !loggedIn ? (
              <div className="save-manual">
                <div className="notice">
                  একসাথে সেভ করতে বট পাসওয়ার্ড দিয়ে লগইন করুন। প্রত্যেক ব্যবহারকারীর সেশন
                  আলাদা; আপনার পাসওয়ার্ড সংরক্ষণ করা হবে না।
                </div>
                <div className="save-actions">
                  <button type="button" className="button ghost" onClick={() => setSaveOpen(false)}>
                    বন্ধ
                  </button>
                  <button type="button" className="button primary" onClick={() => setLoginOpen(true)}>
                    লগইন করুন
                  </button>
                </div>
              </div>
            ) : (
              <div className="save-manual">
                <div className="save-summary">
                  <div className="summary-tile">
                    <strong>{bn(selectedPages.length)}</strong>
                    <span>মোট নির্বাচিত</span>
                  </div>
                  <div className="summary-tile">
                    <strong>{bn(selectedPages.filter((page) => page.kind === "create").length)}</strong>
                    <span>নতুন তৈরি হবে</span>
                  </div>
                  <div className="summary-tile">
                    <strong>{bn(selectedPages.filter((page) => page.kind === "update").length)}</strong>
                    <span>লেভেল ০ হবে</span>
                  </div>
                </div>
                <div className="save-options">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={(event) => setDryRun(event.target.checked)}
                      disabled={saveRunning}
                    />
                    <span>
                      <strong>পরীক্ষা মোড</strong> — কোনো পাতা সেভ হবে না, শুধু ফলাফল দেখাবে
                    </span>
                  </label>
                  <label className="field">
                    <span>সম্পাদনা সারাংশ</span>
                    <input
                      type="text"
                      value={saveSummary}
                      onChange={(event) => setSaveSummary(event.target.value)}
                      maxLength={500}
                      disabled={saveRunning}
                    />
                  </label>
                </div>
                {!saveRunning && !saveFinished ? (
                  <div className="save-actions">
                    <button type="button" className="button ghost" onClick={() => setSaveOpen(false)}>
                      বাতিল
                    </button>
                    <button type="button" className="button primary" onClick={() => void startBotSave()}>
                      {dryRun ? "পরীক্ষা চালান" : "সেভ করুন"}
                    </button>
                  </div>
                ) : null}
                {saveRunning || saveFinished ? (
                  <div className="save-progress-panel">
                    <div className="progress-head">
                      <div>
                        <strong>
                          {bn(saveProgress.done)} / {bn(saveProgress.total)}
                        </strong>
                        <span className="muted">{saveProgress.sub}</span>
                      </div>
                      {saveRunning ? (
                        <button type="button" className="button ghost danger small" onClick={stopBotSave}>
                          থামান
                        </button>
                      ) : null}
                    </div>
                    <div className="progress-track large">
                      <span
                        style={{
                          width: `${saveProgress.total ? Math.round((saveProgress.done / saveProgress.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <div className="save-results">
                      {saveResults.map((result, index) => (
                        <div key={`${result.num}-${index}`} className={`result-row ${result.type}`}>
                          <span className="result-icon">
                            {result.type === "saved" ? "✓" : result.type === "dry" ? "✓" : result.type === "skipped" ? "!" : "×"}
                          </span>
                          <span className="result-page">পৃষ্ঠা {bn(result.num)}</span>
                          <span className="result-msg">{result.message}</span>
                        </div>
                      ))}
                      {saveFinished ? (
                        <div className="result-summary">
                          <strong>{dryRun ? "পরীক্ষা সম্পন্ন।" : "কাজ সম্পন্ন।"}</strong>{" "}
                          {dryRun
                            ? "কোনো কিছু সেভ হয়নি; পরীক্ষা মোড বন্ধ করে আবার চালান।"
                            : `${bn(saveResults.filter((result) => result.type === "saved").length)}টি পাতা সেভ হয়েছে।`}
                        </div>
                      ) : null}
                    </div>
                    {saveFinished ? (
                      <div className="save-actions">
                        <button type="button" className="button primary" onClick={() => setSaveOpen(false)}>
                          বন্ধ করুন
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className={`toast ${toast.tone === "error" ? "is-error" : toast.tone === "success" ? "is-success" : ""}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}
    </>
  );
}

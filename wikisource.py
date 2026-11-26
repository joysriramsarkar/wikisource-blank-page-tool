# -*- coding: utf-8 -*-
"""Wikisource API client and blank-page analysis.

The module talks to a MediaWiki installation directly (no Pywikibot
dependency) and only needs ``requests``.
"""

from __future__ import annotations

import html
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Iterable

import requests

USER_AGENT = (
    "WikisourceBlankPageTool/1.0 "
    "(local Wikisource proofreading helper; python-requests)"
)

DEFAULT_TIMEOUT = 45
MAX_EXISTING_PAGES = 5000
PAGE_BATCH = 40
THUMB_WIDTH = 500
FULL_WIDTH = 1280

BN_DIGITS = "০১২৩৪৫৬৭৮৯"
ASCII_DIGITS = "0123456789"
_TO_ASCII = str.maketrans(BN_DIGITS, ASCII_DIGITS)
_TO_BN = str.maketrans(ASCII_DIGITS, BN_DIGITS)

BLANK_DASHES = set("—–−‒―‐-")

NUMBERING_SCHEMES = {
    "roman", "highroman", "lowroman", "lowerroman", "upperroman",
    "arabic", "decimal", "alpha", "loweralpha", "upperalpha",
    "letters", "latin", "bengali", "bn", "none",
}

# Number of pages fetched in one query when reading wikitext.
PAGELIST_TAG_RE = re.compile(r"<pagelist\b([^>]*)>", re.IGNORECASE | re.DOTALL)
PAGELIST_ATTR_RE = re.compile(
    r"""([0-9০-৯]+)\s*
        (?:(?:to|–|—|-)\s*([0-9০-৯]+))?
        \s*=\s*
        (?:"([^"]*)"|'([^']*)'|([^\s/>]+))""",
    re.IGNORECASE | re.VERBOSE,
)

PAGEQUALITY_TAG_RE = re.compile(r"<pagequality\b[^>]*/\s*>", re.IGNORECASE)
PAGEQUALITY_OPEN_RE = re.compile(r"<pagequality\b[^>]*>", re.IGNORECASE)
PAGEQUALITY_PAIR_RE = re.compile(
    r"<pagequality\b[^>]*>.*?</pagequality\s*>", re.IGNORECASE | re.DOTALL)
PAGEQUALITY_LEVEL_RE = re.compile(r"\blevel\s*=\s*[\"']?(\d+)", re.IGNORECASE)
PAGEQUALITY_USER_RE = re.compile(r"\buser\s*=\s*[\"']([^\"']*)", re.IGNORECASE)

NOINCLUDE_RE = re.compile(r"<noinclude\b[^>]*>.*?</noinclude\s*>", re.IGNORECASE | re.DOTALL)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")
MAGIC_WORD_RE = re.compile(r"__[A-Z]+__")
EMPTY_TEMPLATE_RE = re.compile(
    r"\{\{\s*(?:nop|gap|blank|empty|clear|dhr|rh|running\s+header|page\s+header|-)\s*(?:\|[^{}]*)?\}\}",
    re.IGNORECASE,
)
REDIRECT_RE = re.compile(r"^\s*#\s*(?:redirect|পুনর্নির্দেশ)", re.IGNORECASE)

LEVEL_NAMES = {
    0: "লেখাবিহীন",
    1: "অপ্রুফকৃত",
    2: "সমস্যাযুক্ত",
    3: "প্রুফকৃত",
    4: "যাচাইকৃত",
}


class WikiError(Exception):
    """A readable error raised by the API layer or the analyzer."""

    def __init__(self, message: str, *, code: str = "error", details: Any = None,
                 suggestions: Iterable[str] | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.details = details
        self.suggestions = list(suggestions or [])


class TokenError(WikiError):
    def __init__(self, message: str = "CSRF token expired"):
        super().__init__(message, code="badtoken")


class LoginError(WikiError):
    def __init__(self, message: str, *, code: str = "login-failed", details: Any = None):
        super().__init__(message, code=code, details=details)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def to_ascii_digits(value: str) -> str:
    return value.translate(_TO_ASCII)


def to_bn_digits(value: str | int) -> str:
    return str(value).translate(_TO_BN)


def page_number(title: str) -> int | None:
    """Return the numeric scan-page suffix of a Page: title, if any."""
    suffix = title.rsplit("/", 1)[-1]
    if re.fullmatch(r"[0-9০-৯]+", suffix):
        return int(to_ascii_digits(suffix))
    return None


def digit_style(title: str) -> str:
    suffix = title.rsplit("/", 1)[-1]
    return "bn" if any(ch in BN_DIGITS for ch in suffix) else "ascii"


def format_page_number(number: int, style: str) -> str:
    return to_bn_digits(number) if style == "bn" else str(number)


def is_blank_marker(value: str) -> bool:
    """True for values such as '—', '-', '--' used by <pagelist>."""
    compact = re.sub(r"\s+", "", value or "")
    return bool(compact) and all(ch in BLANK_DASHES for ch in compact)


def is_numbering_scheme(value: str) -> bool:
    """True for pagelist values such as 'roman' or 'prpbengalicurrency'.

    Anything containing non-Latin letters (for example a Bengali label like
    'প্রচ্ছদ') is a page label, not a numbering scheme.
    """
    compact = re.sub(r"\s+", "", (value or "").lower())
    if not compact:
        return True
    if not re.fullmatch(r"[a-z]+", compact):
        return False
    return compact in NUMBERING_SCHEMES or compact.startswith("prp")


def body_text(content: str | None) -> str:
    """Strip ProofreadPage chrome so only the real body text remains."""
    if not content:
        return ""
    text = content
    text = COMMENT_RE.sub("", text)
    text = NOINCLUDE_RE.sub("", text)
    text = PAGEQUALITY_TAG_RE.sub("", text)
    text = re.sub(r"<pagequality\b[^>]*>.*?</pagequality\s*>", "", text,
                  flags=re.IGNORECASE | re.DOTALL)
    text = EMPTY_TEMPLATE_RE.sub("", text)
    text = HTML_TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = MAGIC_WORD_RE.sub("", text)
    text = text.replace("\u00a0", " ")
    return text.strip()


def is_blank_content(content: str | None) -> bool:
    """A Page: page is empty when no letters or digits remain in its body."""
    if content is None:
        return True
    return not re.search(r"[^\W_]", body_text(content), re.UNICODE)


def parse_quality(content: str | None) -> tuple[int | None, str | None]:
    if not content:
        return None, None
    tag = PAGEQUALITY_OPEN_RE.search(content)
    if not tag:
        return None, None
    tag_text = tag.group(0)
    level_match = PAGEQUALITY_LEVEL_RE.search(tag_text)
    user_match = PAGEQUALITY_USER_RE.search(tag_text)
    level = int(level_match.group(1)) if level_match else None
    user = user_match.group(1) if user_match else None
    return level, user


def build_blank_content(username: str) -> str:
    safe_user = html.escape(username or "", quote=True)
    return f'<noinclude><pagequality level="0" user="{safe_user}" /></noinclude>'


def set_quality_zero(content: str, username: str) -> str:
    """Set an existing page's pagequality to level 0, keeping everything else."""
    safe_user = html.escape(username or "", quote=True)
    new_tag = f'<pagequality level="0" user="{safe_user}" />'
    if PAGEQUALITY_PAIR_RE.search(content):
        return PAGEQUALITY_PAIR_RE.sub(new_tag, content, count=1)
    if PAGEQUALITY_TAG_RE.search(content):
        return PAGEQUALITY_TAG_RE.sub(new_tag, content, count=1)
    return build_blank_content(username) + (content or "")


def excerpt(content: str | None, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", body_text(content or "")).strip()
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def normalize_wiki_url(wiki: str) -> str:
    value = (wiki or "").strip()
    if not value:
        raise WikiError("উইকির ঠিকানা দেওয়া হয়নি।", code="bad-wiki")
    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = "https://" + value
    parsed = urllib.parse.urlsplit(value)
    if not parsed.netloc:
        raise WikiError("উইকির ঠিকানা ঠিক নয়।", code="bad-wiki")
    return f"{parsed.scheme}://{parsed.netloc}"


def infer_wiki_from_input(value: str) -> str | None:
    match = re.match(r"^https?://([^/\s]+)", (value or "").strip(), re.IGNORECASE)
    if match:
        return "https://" + match.group(1)
    return None


# ---------------------------------------------------------------------------
# Pagelist parsing
# ---------------------------------------------------------------------------

@dataclass
class Pagelist:
    blank_pages: set[int] = field(default_factory=set)
    labels: dict[int, str] = field(default_factory=dict)
    max_page: int = 0
    tag_count: int = 0


def parse_pagelist(text: str) -> Pagelist:
    result = Pagelist()
    for tag in PAGELIST_TAG_RE.finditer(text or ""):
        result.tag_count += 1
        attrs = tag.group(1)
        for match in PAGELIST_ATTR_RE.finditer(attrs):
            start = int(to_ascii_digits(match.group(1)))
            end_text = match.group(2)
            end = int(to_ascii_digits(end_text)) if end_text else start
            if start < 1 or end < start:
                continue
            raw_value = next((g for g in match.groups()[2:] if g is not None), "")
            value = re.sub(r"\s+", " ", html.unescape(raw_value)).strip()
            result.max_page = max(result.max_page, end)
            if is_blank_marker(value):
                result.blank_pages.update(range(start, end + 1))
            elif value and not is_numbering_scheme(value):
                for number in range(start, end + 1):
                    result.labels.setdefault(number, value)
    return result


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class WikiClient:
    def __init__(self, wiki: str):
        self.origin = normalize_wiki_url(wiki)
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        })
        self.api: str | None = None
        self.lang = "en"
        self.sitename = ""
        self.article_path = "/wiki"
        self.ns_index = "Index"
        self.ns_page = "Page"
        self.ns_file = "File"
        self.username = ""
        self.groups: list[str] = []
        self.rights: list[str] = []
        self._csrf: str | None = None
        self._discover()

    # -- low level ---------------------------------------------------------

    def _transport(self, url: str, params: dict[str, Any], *,
                   method: str = "GET", timeout: int = DEFAULT_TIMEOUT) -> dict[str, Any]:
        payload = {**params, "format": "json", "formatversion": "2"}
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                if method == "POST":
                    response = self.session.post(url, data=payload, timeout=timeout)
                else:
                    response = self.session.get(url, params=payload, timeout=timeout)
                if response.status_code in (429, 500, 502, 503, 504):
                    last_error = WikiError(
                        f"সার্ভার এখন সাড়া দিচ্ছে না (HTTP {response.status_code})।",
                        code="http", details=response.status_code,
                    )
                    time.sleep(min(2 ** attempt, 8))
                    continue
                if response.status_code >= 400:
                    raise WikiError(
                        f"উইকি API ত্রুটি (HTTP {response.status_code})।",
                        code="http", details=response.text[:400],
                    )
                try:
                    return response.json()
                except ValueError:
                    last_error = WikiError(
                        "উইকি API থেকে বৈধ JSON পাওয়া যায়নি।",
                        code="bad-json", details=response.text[:400],
                    )
                    time.sleep(1 + attempt)
            except requests.RequestException as error:
                last_error = WikiError(
                    "উইকির সাথে সংযোগ করা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করুন।",
                    code="network", details=str(error),
                )
                time.sleep(min(2 ** attempt, 8))
        raise last_error or WikiError("উইকি API অনুরোধ ব্যর্থ হয়েছে।", code="network")

    def _call(self, params: dict[str, Any], *, method: str = "GET",
              write: bool = False, timeout: int = DEFAULT_TIMEOUT) -> dict[str, Any]:
        if not self.api:
            raise WikiError("উইকি API ঠিকানা পাওয়া যায়নি।", code="no-api")
        payload = dict(params)
        if write:
            payload["maxlag"] = 5
        for attempt in range(3):
            data = self._transport(self.api, payload, method=method, timeout=timeout)
            error = data.get("error")
            if not error:
                return data
            code = error.get("code", "error")
            if code == "maxlag" and attempt < 2:
                time.sleep(min(int(error.get("lag", 5)) + 1, 10))
                continue
            if code == "badtoken":
                raise TokenError(error.get("info", "CSRF token expired"))
            raise WikiError(
                error.get("info") or "উইকি API ত্রুটি।",
                code=code, details=error,
            )
        raise WikiError("উইকি API বারবার ব্যস্ত আছে; কিছুক্ষণ পরে চেষ্টা করুন।",
                        code="maxlag")

    def _discover(self) -> None:
        candidates = [self.origin + "/w/api.php", self.origin + "/api.php"]
        last_error: Exception | None = None
        for candidate in candidates:
            try:
                data = self._transport(candidate, {
                    "action": "query",
                    "meta": "siteinfo",
                    "siprop": "general|namespaces",
                })
                if "error" in data:
                    last_error = WikiError(data["error"].get("info", "siteinfo failed"))
                    continue
                info = data["query"]["general"]
                self.api = candidate
                self.lang = info.get("lang", "en")
                self.sitename = info.get("sitename", "")
                self.article_path = info.get("articlepath", "/wiki")
                namespaces = data["query"]["namespaces"]
                self.ns_index = self._namespace_name(namespaces, 102, "Index")
                self.ns_page = self._namespace_name(namespaces, 104, "Page")
                self.ns_file = self._namespace_name(namespaces, 6, "File")
                return
            except WikiError as error:
                last_error = error
        raise last_error or WikiError(
            "এই উইকির API পাওয়া যায়নি। ঠিকানা পরীক্ষা করুন।", code="no-api")

    @staticmethod
    def _namespace_name(namespaces: dict[str, Any], ns_id: int, fallback: str) -> str:
        entry = namespaces.get(str(ns_id)) or {}
        return entry.get("*") or entry.get("name") or fallback

    # -- URLs --------------------------------------------------------------

    def page_url(self, title: str) -> str:
        quoted = urllib.parse.quote(title.replace(" ", "_"), safe="/:")
        path = self.article_path or "/wiki/$1"
        if "$1" in path:
            return f"{self.origin}{path.replace('$1', quoted)}"
        return f"{self.origin}{path.rstrip('/')}/{quoted}"

    def file_url(self, title: str) -> str:
        return self.page_url(title)

    # -- reads -------------------------------------------------------------

    @staticmethod
    def _normalize_page(page: dict[str, Any]) -> dict[str, Any]:
        revision = (page.get("revisions") or [None])[0]
        content = None
        revid = page.get("lastrevid")
        user = None
        timestamp = None
        if revision:
            content = (revision.get("slots", {}).get("main") or {}).get("content")
            if content is None:
                content = revision.get("*")
            revid = revision.get("revid", revid)
            user = revision.get("user")
            timestamp = revision.get("timestamp")
        return {
            "title": page.get("title", ""),
            "ns": page.get("ns"),
            "missing": bool(page.get("missing")),
            "redirect": bool(page.get("redirect")),
            "content": content,
            "revid": revid,
            "user": user,
            "timestamp": timestamp,
        }

    def get_page(self, title: str, *, follow_redirects: bool = False) -> dict[str, Any]:
        params: dict[str, Any] = {
            "action": "query",
            "prop": "info|revisions",
            "rvprop": "ids|content|timestamp|user",
            "rvslots": "main",
            "titles": title,
        }
        if follow_redirects:
            params["redirects"] = "1"
        data = self._call(params)
        pages = data.get("query", {}).get("pages") or []
        if not pages:
            raise WikiError("উইকি থেকে পাতার তথ্য পাওয়া যায়নি।", code="no-page")
        return self._normalize_page(pages[0])

    def get_pages(self, titles: Iterable[str]) -> list[dict[str, Any]]:
        unique = list(dict.fromkeys(titles))
        results: list[dict[str, Any]] = []
        for offset in range(0, len(unique), PAGE_BATCH):
            batch = unique[offset:offset + PAGE_BATCH]
            joined = "|".join(batch)
            method = "POST" if len(joined) > 3000 else "GET"
            data = self._call({
                "action": "query",
                "prop": "info|revisions",
                "rvprop": "ids|content|timestamp|user",
                "rvslots": "main",
                "titles": joined,
            }, method=method)
            for page in data.get("query", {}).get("pages") or []:
                results.append(self._normalize_page(page))
        return results

    def list_page_titles(self, prefix: str) -> list[str]:
        titles: list[str] = []
        continuation: dict[str, Any] = {}
        while True:
            params = {
                "action": "query",
                "list": "allpages",
                "apnamespace": 104,
                "apprefix": prefix,
                "aplimit": 500,
                "apfilterredir": "all",
                **continuation,
            }
            data = self._call(params)
            titles.extend(page["title"] for page in data["query"]["allpages"])
            if "continue" not in data:
                break
            continuation = data["continue"]
        return titles

    def imageinfo(self, file_title: str) -> dict[str, Any] | None:
        data = self._call({
            "action": "query",
            "prop": "imageinfo",
            "iiprop": "url|size|mime",
            "iiurlwidth": THUMB_WIDTH,
            "titles": file_title,
        })
        pages = data.get("query", {}).get("pages") or []
        if not pages:
            return None
        info = (pages[0].get("imageinfo") or [None])[0]
        return info

    def search_index_details(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        """Search the Index namespace and return title + snippet results."""
        value = (query or "").strip()
        for prefix in (self.ns_index, "Index"):
            if value.lower().startswith(prefix.lower() + ":"):
                value = value[len(prefix) + 1:]
                break
        value = value.strip()
        if len(value) < 2:
            return []

        results: list[dict[str, Any]] = []
        seen: set[str] = set()

        try:
            data = self._call({
                "action": "query",
                "list": "prefixsearch",
                "pssearch": value,
                "psnamespace": 102,
                "pslimit": limit,
            })
            for item in data.get("query", {}).get("prefixsearch", []):
                title = item.get("title")
                if title and title not in seen:
                    seen.add(title)
                    results.append({"title": title, "snippet": "", "source": "prefix"})
        except WikiError:
            pass

        if len(results) < limit:
            try:
                data = self._call({
                    "action": "query",
                    "list": "search",
                    "srnamespace": 102,
                    "srsearch": value,
                    "srlimit": limit,
                    "srprop": "snippet",
                })
                for hit in data.get("query", {}).get("search", []):
                    title = hit.get("title")
                    if not title or title in seen:
                        continue
                    snippet = re.sub(r"<[^>]+>", " ", hit.get("snippet") or "")
                    snippet = re.sub(r"\s+", " ", html.unescape(snippet)).strip()
                    seen.add(title)
                    results.append({
                        "title": title,
                        "snippet": snippet,
                        "source": "search",
                    })
            except WikiError:
                pass

        return results[:limit]

    def search_index(self, query: str) -> list[str]:
        return [item["title"] for item in self.search_index_details(query)]

    # -- index resolution --------------------------------------------------

    def _extract_title(self, user_input: str) -> str:
        value = (user_input or "").strip()
        if not value:
            raise WikiError("বই বা নির্ঘণ্টের নাম লিখুন।", code="empty-input")
        if re.match(r"^https?://", value, re.IGNORECASE):
            parsed = urllib.parse.urlsplit(value)
            query = urllib.parse.parse_qs(parsed.query)
            if query.get("title"):
                value = query["title"][0]
            else:
                path = urllib.parse.unquote(parsed.path)
                marker = "/wiki/"
                if marker in path:
                    value = path.split(marker, 1)[1]
                else:
                    raise WikiError(
                        "লিংক থেকে নির্ঘণ্টের নাম পড়া যায়নি।",
                        code="bad-url",
                    )
        value = urllib.parse.unquote(value).replace("_", " ").strip().lstrip(":")
        for prefix in (self.ns_index, "Index"):
            if value.lower().startswith(prefix.lower() + ":"):
                value = value[len(prefix) + 1:]
                break
        for prefix in (self.ns_page, "Page"):
            if value.lower().startswith(prefix.lower() + ":"):
                raise WikiError(
                    "এটি একটি পাতা (Page:), নির্ঘণ্ট নয়। নির্ঘণ্ট পাতার নাম দিন।",
                    code="page-not-index",
                )
        for prefix in (self.ns_file, "File"):
            if value.lower().startswith(prefix.lower() + ":"):
                value = value[len(prefix) + 1:]
                break
        value = value.strip()
        if not value:
            raise WikiError("নির্ঘণ্টের নাম খালি।", code="empty-input")
        return value

    def resolve_index(self, user_input: str) -> dict[str, Any]:
        base = self._extract_title(user_input)
        seen: set[str] = set()
        for prefix in (self.ns_index, "Index"):
            title = f"{prefix}:{base}"
            if title in seen:
                continue
            seen.add(title)
            page = self.get_page(title, follow_redirects=True)
            if not page["missing"] and page["ns"] == 102:
                return page
        hits = self.search_index(base)
        if hits:
            raise WikiError(
                "এই নামে সরাসরি নির্ঘণ্ট পাওয়া যায়নি। নিচের ফলাফল থেকে বেছে নিন।",
                code="not-found", suggestions=hits,
            )
        raise WikiError(
            "এই নামে কোনো নির্ঘণ্ট পাতা পাওয়া যায়নি। "
            "ফাইলের নাম বা নির্ঘণ্ট পাতার লিংক ঠিকভাবে দিন।",
            code="not-found",
        )

    # -- analysis ----------------------------------------------------------

    def analyze(self, user_input: str) -> dict[str, Any]:
        index = self.resolve_index(user_input)
        base = index["title"].split(":", 1)[1]
        content = index["content"] or ""
        pagelist = parse_pagelist(content)
        file_title = f"{self.ns_file}:{base}"
        info = self.imageinfo(file_title)
        pagecount = int(info["pagecount"]) if info and info.get("pagecount") else 0
        thumb_base = None
        file_page_url = self.file_url(file_title)
        if info:
            thumb_url = info.get("thumburl")
            if thumb_url:
                thumb_base = thumb_url.split("?")[0]
            if info.get("descriptionurl"):
                file_page_url = info["descriptionurl"]

        existing_titles = self.list_page_titles(base + "/")
        numeric_titles: list[tuple[int, str]] = []
        for title in existing_titles:
            number = page_number(title)
            if number is not None and number >= 1:
                numeric_titles.append((number, title))
        truncated = len(numeric_titles) > MAX_EXISTING_PAGES
        if truncated:
            numeric_titles = numeric_titles[:MAX_EXISTING_PAGES]

        pages = self.get_pages([title for _, title in numeric_titles])
        pages = [page for page in pages if page_number(page["title"]) is not None]

        style = self._infer_style(pages)
        by_number: dict[int, list[dict[str, Any]]] = {}
        for page in pages:
            number = page_number(page["title"])
            if number is None:
                continue
            by_number.setdefault(number, []).append(page)

        if not pagecount:
            fallback_max = max(
                [pagelist.max_page]
                + [number for number in by_number]
                + [1]
            )
            pagecount = fallback_max

        warnings: list[str] = []
        if pagelist.tag_count == 0:
            warnings.append(
                "এই নির্ঘণ্টে <pagelist> পাওয়া যায়নি; শুধু বিদ্যমান খালি পাতাগুলো দেখানো হচ্ছে।"
            )
        elif not pagelist.blank_pages:
            warnings.append(
                "pagelist-এ ফাঁকা পাতার কোনো চিহ্ন (— বা -) পাওয়া যায়নি।"
            )
        if not info:
            warnings.append(
                "স্ক্যান ফাইলের তথ্য পাওয়া যায়নি; পাতা সংখ্যা নির্ঘণ্ট থেকে অনুমান করা হয়েছে।"
            )
        if truncated:
            warnings.append(
                f"এই বইয়ে {MAX_EXISTING_PAGES}টির বেশি পাতা আছে; শুধু প্রথম "
                f"{MAX_EXISTING_PAGES}টি পরীক্ষা করা হয়েছে।"
            )
        if pagelist.max_page > pagecount:
            overflow = sorted(n for n in pagelist.blank_pages if n > pagecount)
            if overflow:
                warnings.append(
                    f"{len(overflow)}টি ফাঁকা পাতা স্ক্যানের মোট পাতা "
                    f"({pagecount}) ছাড়িয়ে গেছে; সেগুলো আলাদা করে যাচাই করুন।"
                )
        mixed_styles = self._has_mixed_styles(pages)
        if mixed_styles:
            default_label = "বাংলা" if style == "bn" else "ইংরেজি"
            warnings.append(
                "এই বইয়ে বাংলা ও ইংরেজি — দুই রকম অঙ্কে পাতা তৈরি হয়েছে; "
                f"নতুন পাতা {default_label} অঙ্কে তৈরি হবে।"
            )

        records: list[dict[str, Any]] = []
        text_pages = 0
        redirect_titles: list[str] = []
        duplicate_numbers: set[int] = set()
        blank_out_of_range = 0

        for number in sorted(set(pagelist.blank_pages) | set(by_number)):
            group = by_number.get(number, [])
            redirects_here = [page for page in group if page["redirect"]]
            redirect_titles.extend(page["title"] for page in redirects_here)
            primary = self._choose_primary(group, style)
            in_pagelist = number in pagelist.blank_pages
            out_of_range = bool(pagecount and number > pagecount)
            if out_of_range and in_pagelist:
                blank_out_of_range += 1

            if primary is None:
                if not in_pagelist:
                    continue
                if redirects_here:
                    # Only a redirect exists: never overwrite it.
                    title = redirects_here[0]["title"]
                    level, _ = parse_quality(redirects_here[0]["content"])
                    records.append(self._record(
                        number, title, "redirect", level, False, "",
                        None, None, None, pagecount, thumb_base, style,
                        pagelist, other_titles=[],
                    ))
                    continue
                title = self._page_title(base, number, style)
                records.append(self._record(
                    number, title, "create", None, False, "",
                    None, None, None, pagecount, thumb_base, style,
                    pagelist, other_titles=[],
                ))
                continue

            title = primary["title"]
            page_content = primary["content"] or ""
            level, _ = parse_quality(page_content)
            empty = is_blank_content(page_content)
            others = [
                page["title"] for page in group
                if page is not primary and not page["redirect"] and not page["missing"]
            ]
            if others:
                duplicate_numbers.add(number)
            other_titles = others + [page["title"] for page in redirects_here]

            if empty:
                kind = "done" if level == 0 else "update"
                records.append(self._record(
                    number, title, kind, level, False, "",
                    primary.get("user"), primary.get("timestamp"), primary.get("revid"),
                    pagecount, thumb_base, style, pagelist,
                    other_titles=other_titles,
                ))
            else:
                if in_pagelist:
                    records.append(self._record(
                        number, title, "conflict", level, True,
                        excerpt(page_content),
                        primary.get("user"), primary.get("timestamp"), primary.get("revid"),
                        pagecount, thumb_base, style, pagelist,
                        other_titles=other_titles,
                    ))
                else:
                    text_pages += 1

        redirect_titles = sorted(set(redirect_titles))
        if duplicate_numbers:
            warnings.append(
                f"{len(duplicate_numbers)}টি স্ক্যান পাতার একাধিক পাতা আছে; "
                "নিরাপত্তার জন্য কার্ডে বিস্তারিত দেখুন।"
            )
        conflicts = sum(1 for record in records if record["kind"] == "conflict")
        if conflicts:
            warnings.append(
                f"{conflicts}টি ফাঁকা চিহ্নিত পাতায় লেখা আছে; "
                "ভুল এড়াতে সেগুলো বাদ দেওয়া হয়েছে।"
            )

        stats = {
            "pagecount": pagecount,
            "marked_blank": len(pagelist.blank_pages),
            "existing_pages": len(pages),
            "existing_content_pages": sum(1 for page in pages if not page["redirect"]),
            "create": sum(1 for record in records if record["kind"] == "create"),
            "update": sum(1 for record in records if record["kind"] == "update"),
            "done": sum(1 for record in records if record["kind"] == "done"),
            "conflict": conflicts,
            "redirect": sum(1 for record in records if record["kind"] == "redirect"),
            "text_pages": text_pages,
            "candidates": len(records),
            "pending": sum(1 for record in records if record["kind"] in ("create", "update")),
            "style": style,
            "truncated": truncated,
        }

        return {
            "wiki": {
                "origin": self.origin,
                "api": self.api,
                "article_path": self.article_path,
                "index_ns": self.ns_index,
                "page_ns": self.ns_page,
                "lang": self.lang,
                "sitename": self.sitename,
            },
            "index": {
                "title": index["title"],
                "base": base,
                "file_title": file_title,
                "file_page_url": file_page_url,
                "url": self.page_url(index["title"]),
                "revid": index["revid"],
                "pagecount": pagecount,
                "thumb_base": thumb_base,
            },
            "stats": stats,
            "pages": records,
            "warnings": warnings,
            "markers": sorted(BLANK_DASHES),
            "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "_internal": {
                "by_number": by_number,
                "blank_pages": sorted(pagelist.blank_pages),
                "labels": pagelist.labels,
            },
        }

    def _infer_style(self, pages: list[dict[str, Any]]) -> str:
        bn = ascii_count = 0
        for page in pages:
            if page["redirect"] or page["missing"]:
                continue
            if digit_style(page["title"]) == "bn":
                bn += 1
            else:
                ascii_count += 1
        if bn and not ascii_count:
            return "bn"
        if ascii_count and not bn:
            return "ascii"
        if bn or ascii_count:
            return "bn" if bn >= ascii_count else "ascii"
        return "bn" if self.lang == "bn" else "ascii"

    @staticmethod
    def _has_mixed_styles(pages: list[dict[str, Any]]) -> bool:
        styles = {
            digit_style(page["title"])
            for page in pages
            if not page["redirect"] and not page["missing"]
        }
        return len(styles) > 1

    @staticmethod
    def _choose_primary(group: list[dict[str, Any]],
                        style: str) -> dict[str, Any] | None:
        candidates = [
            page for page in group
            if not page["redirect"] and not page["missing"]
        ]
        if not candidates:
            return None

        def sort_key(page: dict[str, Any]):
            has_text = not is_blank_content(page["content"])
            return (
                0 if has_text else 1,
                0 if digit_style(page["title"]) == style else 1,
                page["title"],
            )

        return sorted(candidates, key=sort_key)[0]

    def _page_title(self, base: str, number: int, style: str) -> str:
        return f"{self.ns_page}:{base}/{format_page_number(number, style)}"

    def _record(self, number: int, title: str, kind: str, level: int | None,
                has_text: bool, text_excerpt: str, user: str | None,
                timestamp: str | None, revid: int | None, pagecount: int,
                thumb_base: str | None, style: str, pagelist: Pagelist, *,
                other_titles: list[str]) -> dict[str, Any]:
        thumb = None
        full = None
        if thumb_base and (not pagecount or number <= pagecount):
            thumb = re.sub(r"page\d+-\d+px", f"page{number}-{THUMB_WIDTH}px",
                           thumb_base, count=1)
            full = re.sub(r"page\d+-\d+px", f"page{number}-{FULL_WIDTH}px",
                          thumb_base, count=1)
        label = pagelist.labels.get(number)
        if label and re.fullmatch(r"[0-9]+", label):
            label = to_bn_digits(label)
        return {
            "num": number,
            "num_label": to_bn_digits(number) if style == "bn" else str(number),
            "title": title,
            "label": label,
            "kind": kind,
            "level": level,
            "has_text": has_text,
            "excerpt": text_excerpt,
            "user": user,
            "timestamp": timestamp,
            "revid": revid,
            "thumb": thumb,
            "full": full,
            "url": self.page_url(title),
            "other_titles": other_titles,
            "out_of_range": bool(pagecount and number > pagecount),
            "level_name": LEVEL_NAMES.get(level) if level is not None else None,
        }

    def manual_page_record(self, number: int, group: list[dict[str, Any]], *,
                           base: str, style: str, pagecount: int,
                           thumb_base: str | None, labels: dict[int, str],
                           in_pagelist: bool) -> dict[str, Any]:
        """Build a record for one scan page while browsing the whole book."""
        primary = self._choose_primary(group, style)
        redirects = [page for page in group if page["redirect"]]
        chosen = primary or (redirects[0] if redirects else None)
        other_titles = [
            page["title"] for page in group
            if page is not chosen and not page["missing"]
        ]
        label = labels.get(number)
        pagelist = Pagelist(labels={number: label} if label else {})

        if primary is None:
            if redirects:
                page = redirects[0]
                level, _ = parse_quality(page["content"])
                record = self._record(
                    number, page["title"], "redirect", level, False, "",
                    page.get("user"), page.get("timestamp"), page.get("revid"),
                    pagecount, thumb_base, style, pagelist,
                    other_titles=other_titles,
                )
            else:
                title = self._page_title(base, number, style)
                record = self._record(
                    number, title, "create", None, False, "",
                    None, None, None, pagecount, thumb_base, style, pagelist,
                    other_titles=other_titles,
                )
        else:
            content = primary["content"] or ""
            level, _ = parse_quality(content)
            empty = is_blank_content(content)
            title = primary["title"]
            if empty:
                kind = "done" if level == 0 else "update"
                record = self._record(
                    number, title, kind, level, False, "",
                    primary.get("user"), primary.get("timestamp"),
                    primary.get("revid"), pagecount, thumb_base, style, pagelist,
                    other_titles=other_titles,
                )
            else:
                record = self._record(
                    number, title, "conflict", level, True, excerpt(content),
                    primary.get("user"), primary.get("timestamp"),
                    primary.get("revid"), pagecount, thumb_base, style, pagelist,
                    other_titles=other_titles,
                )

        record["manual"] = True
        record["in_pagelist"] = bool(in_pagelist)
        return record

    # -- login / editing ---------------------------------------------------

    def login(self, username: str, password: str) -> dict[str, Any]:
        if not username or not password:
            raise LoginError("ব্যবহারকারীর নাম ও বট পাসওয়ার্ড দুটোই দিন।")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        })
        token_data = self._call({
            "action": "query",
            "meta": "tokens",
            "type": "login",
        })
        login_token = token_data["query"]["tokens"]["logintoken"]
        data = self._call({
            "action": "login",
            "lgname": username,
            "lgpassword": password,
            "lgtoken": login_token,
        }, method="POST")
        result = data.get("login", {})
        if result.get("result") != "Success":
            reason = result.get("reason") or result.get("result") or "unknown"
            reason_lower = str(reason).lower()
            messages = {
                "WrongPass": "ব্যবহারকারীর নাম বা বট পাসওয়ার্ড ভুল।",
                "NotExists": "এই নামে কোনো ব্যবহারকারী নেই।",
                "Throttled": "অনেকবার লগইন চেষ্টা হয়েছে; কিছুক্ষণ পরে চেষ্টা করুন।",
                "Blocked": "এই অ্যাকাউন্টটি ব্লকড।",
                "UserBlocked": "এই অ্যাকাউন্টটি ব্লকড।",
                "Aborted": "লগইন বাতিল হয়েছে।",
                "NeedToken": "লগইন টোকেন মেলেনি; আবার চেষ্টা করুন।",
                "WrongToken": "লগইন টোকেন মেলেনি; আবার চেষ্টা করুন।",
            }
            if result.get("result") == "FAILED" or "incorrect username or password" in reason_lower:
                message = "ব্যবহারকারীর নাম বা বট পাসওয়ার্ড ভুল।"
            else:
                message = messages.get(
                    result.get("result"),
                    "লগইন ব্যর্থ হয়েছে। ব্যবহারকারীর নাম ও বট পাসওয়ার্ড পরীক্ষা করুন।",
                )
            raise LoginError(
                message,
                code=result.get("result", "login-failed"),
                details=result,
            )
        userinfo = self._call({
            "action": "query",
            "meta": "userinfo",
            "uiprop": "groups|rights",
        })["query"]["userinfo"]
        self.username = userinfo.get("name", "")
        self.groups = userinfo.get("groups", [])
        self.rights = userinfo.get("rights", [])
        self._csrf = None
        return userinfo

    def logout(self) -> None:
        try:
            token = self.csrf_token()
            self._call({
                "action": "logout",
                "token": token,
            }, method="POST")
        except Exception:
            pass
        finally:
            self.session.cookies.clear()
            self.username = ""
            self._csrf = None

    def csrf_token(self, *, force: bool = False) -> str:
        if self._csrf and not force:
            return self._csrf
        data = self._call({
            "action": "query",
            "meta": "tokens",
            "type": "csrf",
        })
        self._csrf = data["query"]["tokens"]["csrftoken"]
        return self._csrf

    def edit(self, title: str, text: str, summary: str, *,
             create: bool = False, baserevid: int | None = None) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(2):
            params: dict[str, Any] = {
                "action": "edit",
                "title": title,
                "text": text,
                "summary": summary or "",
                "watchlist": "nochange",
                "token": self.csrf_token(force=attempt > 0),
                "assert": "user",
            }
            if create:
                params["createonly"] = 1
            else:
                params["nocreate"] = 1
                if baserevid:
                    params["baserevid"] = baserevid
            if "bot" in self.rights:
                params["bot"] = 1
            try:
                data = self._call(params, method="POST", write=True, timeout=90)
                return data.get("edit", data)
            except TokenError as error:
                last_error = error
                continue
        raise last_error or WikiError("সম্পাদনা করা যায়নি।", code="edit-failed")

    def save_blank_page(self, record: dict[str, Any], username: str,
                        summary: str, dry_run: bool) -> dict[str, Any]:
        title = record["title"]
        current = self.get_page(title)
        content = current["content"] or ""
        level, _ = parse_quality(content)
        empty = is_blank_content(content)

        if current["redirect"]:
            return {
                "status": "skipped", "reason": "redirect", "title": title,
                "message": "পাতাটি একটি পুনর্নির্দেশ; এটি বদলানো হয়নি।",
            }

        if current["missing"]:
            if record["kind"] != "create":
                return {
                    "status": "skipped", "reason": "deleted", "title": title,
                    "message": "পাতাটি এর মধ্যে মুছে ফেলা হয়েছে; আবার বিশ্লেষণ করুন।",
                }
            action = "create"
            new_content = build_blank_content(username)
            baserevid = None
        elif empty:
            if level == 0:
                return {
                    "status": "already_done", "title": title,
                    "message": "পাতাটি আগেই লেখাবিহীন (লেভেল ০)।",
                }
            action = "update"
            new_content = set_quality_zero(content, username)
            baserevid = current["revid"]
        else:
            return {
                "status": "skipped", "reason": "has_text", "title": title,
                "message": "পাতায় এখন লেখা আছে; নিরাপত্তার জন্য বদলানো হয়নি।",
                "excerpt": excerpt(content),
            }

        if dry_run:
            return {
                "status": "dry_run",
                "action": action,
                "title": title,
                "level": level,
                "content": new_content,
                "message": ("নতুন পাতা তৈরি হবে।" if action == "create"
                            else "pagequality লেভেল ০ করা হবে।"),
            }

        result = self.edit(
            title, new_content, summary,
            create=(action == "create"),
            baserevid=baserevid,
        )
        return {
            "status": "saved",
            "action": action,
            "title": title,
            "newrevid": result.get("newrevid"),
            "oldrevid": result.get("oldrevid"),
            "nochange": bool(result.get("nochange")),
            "message": ("নতুন পাতা তৈরি হয়েছে।" if action == "create"
                        else "লেখাবিহীন হিসেবে চিহ্নিত হয়েছে।"),
        }

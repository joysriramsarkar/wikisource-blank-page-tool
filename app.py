# -*- coding: utf-8 -*-
"""Local web app for reviewing blank Wikisource pages and marking them
as "without text" (pagequality level 0)."""

from __future__ import annotations

import json
import logging
import re
import secrets
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from collections import OrderedDict
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from wikisource import (
    LoginError,
    WikiClient,
    WikiError,
    infer_wiki_from_input,
    normalize_wiki_url,
)

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
SECRET_PATH = BASE_DIR / "secrets.json"

DEFAULT_CONFIG = {
    "wiki": "https://bn.wikisource.org",
    "username": "",
    "remember": False,
}
DEFAULT_SUMMARY = "বট: নির্ঘণ্ট অনুযায়ী লেখাবিহীন পাতা চিহ্নিত করা হলো"
EDIT_DELAY = 1.2
MAX_CACHED_BOOKS = 6

TOOL_TOKEN = secrets.token_urlsafe(24)

app = Flask(__name__)
app.json.ensure_ascii = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

LOCK = threading.RLock()
BOOKS: "OrderedDict[str, dict]" = OrderedDict()
ANON_CLIENTS: dict[str, WikiClient] = {}
SEARCH_CLIENTS: dict[str, WikiClient] = {}

STATE: dict = {
    "client": None,
    "wiki": None,
    "user": None,
    "groups": [],
    "rights": [],
    "config": {},
    "auto_tried": False,
    "auto_error": None,
}


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def load_config() -> dict:
    config = dict(DEFAULT_CONFIG)
    try:
        if CONFIG_PATH.exists():
            stored = json.loads(CONFIG_PATH.read_text("utf-8"))
            if isinstance(stored, dict):
                config.update({k: stored[k] for k in DEFAULT_CONFIG if k in stored})
    except Exception as error:  # noqa: BLE001
        logging.warning("config.json could not be read: %s", error)
    return config


def save_config(config: dict) -> None:
    try:
        CONFIG_PATH.write_text(
            json.dumps(config, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as error:
        logging.warning("config.json could not be written: %s", error)


def read_password() -> str:
    try:
        if SECRET_PATH.exists():
            data = json.loads(SECRET_PATH.read_text("utf-8"))
            if isinstance(data, dict):
                return str(data.get("password") or "")
    except Exception as error:  # noqa: BLE001
        logging.warning("secrets.json could not be read: %s", error)
    return ""


def write_password(password: str) -> None:
    try:
        SECRET_PATH.write_text(
            json.dumps({"password": password}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as error:
        logging.warning("secrets.json could not be written: %s", error)


def delete_password() -> None:
    try:
        SECRET_PATH.unlink(missing_ok=True)
    except OSError as error:
        logging.warning("secrets.json could not be deleted: %s", error)


STATE["config"] = load_config()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def public_config() -> dict:
    config = STATE["config"]
    return {
        "wiki": config.get("wiki", DEFAULT_CONFIG["wiki"]),
        "username": config.get("username", ""),
        "remember": bool(config.get("remember")),
    }


def status_payload() -> dict:
    config = STATE["config"]
    return {
        "logged_in": bool(STATE["client"] and STATE["user"]),
        "user": STATE["user"],
        "wiki": STATE["wiki"] or config.get("wiki"),
        "config": public_config(),
        "has_password": SECRET_PATH.exists(),
        "auto_error": STATE["auto_error"],
        "default_wiki": DEFAULT_CONFIG["wiki"],
    }


def json_body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def error_response(error: WikiError, status: int = 400):
    return jsonify({
        "error": error.message,
        "code": error.code,
        "details": error.details,
        "suggestions": error.suggestions,
    }), status


def do_login(wiki: str, username: str, password: str, remember: bool) -> dict:
    client = WikiClient(wiki)
    userinfo = client.login(username, password)
    with LOCK:
        STATE.update({
            "client": client,
            "wiki": client.origin,
            "user": userinfo.get("name") or username,
            "groups": userinfo.get("groups", []),
            "rights": userinfo.get("rights", []),
            "auto_error": None,
        })
        config = {
            "wiki": client.origin,
            "username": username,
            "remember": bool(remember),
        }
        STATE["config"] = config
        save_config(config)
        if remember:
            write_password(password)
        else:
            delete_password()
    logging.info("Logged in to %s as %s", client.origin, STATE["user"])
    return userinfo


def try_auto_login() -> None:
    with LOCK:
        if STATE["auto_tried"]:
            return
        STATE["auto_tried"] = True
        config = STATE["config"]
        if STATE["client"] or not config.get("remember") or not config.get("username"):
            return
        password = read_password()
        if not password:
            return
        try:
            do_login(config["wiki"], config["username"], password, True)
        except Exception as error:  # noqa: BLE001
            STATE["auto_error"] = str(error)
            logging.info("Automatic login failed: %s", error)


def cache_book(result: dict, internal: dict | None = None) -> dict:
    origin = result["wiki"]["origin"]
    entry = {
        "origin": origin,
        "index": result["index"],
        "analysis": result,
        "pages_by_num": {page["num"]: page for page in result["pages"]},
    }
    if internal:
        entry["by_number"] = internal.get("by_number", {})
        entry["blank_pages"] = set(internal.get("blank_pages", []))
        entry["labels"] = internal.get("labels", {})
    key = f"{origin}\n{result['index']['title']}"
    with LOCK:
        BOOKS[key] = entry
        BOOKS.move_to_end(key)
        while len(BOOKS) > MAX_CACHED_BOOKS:
            BOOKS.popitem(last=False)
    return entry


def get_book(origin: str, index_title: str) -> dict | None:
    if not origin or not index_title:
        return None
    key = f"{origin}\n{index_title}"
    with LOCK:
        return BOOKS.get(key)


def anonymous_client(origin: str) -> WikiClient:
    client = ANON_CLIENTS.get(origin)
    if client is None:
        client = WikiClient(origin)
        ANON_CLIENTS[origin] = client
    return client


def clean_summary(value: str) -> str:
    summary = re.sub(r"\s+", " ", value or "").strip()
    return summary[:500] or DEFAULT_SUMMARY


# ---------------------------------------------------------------------------
# Web routes
# ---------------------------------------------------------------------------

@app.before_request
def guard_api_writes():
    if request.method == "POST" and request.path.startswith("/api/"):
        if request.headers.get("X-Tool-Token") != TOOL_TOKEN:
            return jsonify({
                "error": "অবৈধ বা পুরনো অনুরোধ। পাতা একবার রিফ্রেশ করুন।",
                "code": "bad-token",
            }), 403
    return None


@app.get("/")
def home():
    return render_template(
        "index.html",
        token=TOOL_TOKEN,
        config=public_config(),
        default_summary=DEFAULT_SUMMARY,
    )


@app.get("/api/status")
def api_status():
    try_auto_login()
    return jsonify(status_payload())


@app.post("/api/login")
def api_login():
    data = json_body()
    wiki = (data.get("wiki") or STATE["config"].get("wiki") or "").strip()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    remember = bool(data.get("remember"))
    if not username or not password:
        return jsonify({
            "error": "ব্যবহারকারীর নাম ও বট পাসওয়ার্ড দুটোই দিন।",
            "code": "missing-credentials",
        }), 400
    try:
        do_login(wiki, username, password, remember)
    except (WikiError, LoginError) as error:
        return error_response(error, 401)
    return jsonify(status_payload())


@app.post("/api/logout")
def api_logout():
    with LOCK:
        client = STATE.get("client")
        if client is not None:
            try:
                client.logout()
            except Exception:  # noqa: BLE001
                pass
        STATE.update({
            "client": None,
            "wiki": None,
            "user": None,
            "groups": [],
            "rights": [],
            "auto_error": None,
        })
    return jsonify(status_payload())


@app.post("/api/analyze")
def api_analyze():
    data = json_body()
    value = (data.get("input") or "").strip()
    if not value:
        return jsonify({"error": "বই বা নির্ঘণ্টের নাম লিখুন।",
                        "code": "empty-input"}), 400
    wiki = (data.get("wiki") or STATE["config"].get("wiki")
            or DEFAULT_CONFIG["wiki"]).strip()
    inferred = infer_wiki_from_input(value)
    if inferred:
        wiki = inferred
    try:
        client = WikiClient(wiki)
        result = client.analyze(value)
    except WikiError as error:
        logging.info("Analyze failed for %r: %s", value, error)
        return error_response(error, 400)
    internal = result.pop("_internal", {})
    cache_book(result, internal)
    logging.info(
        "Analyzed %s: %s candidates (%s create, %s update, %s done, %s conflict)",
        result["index"]["title"],
        result["stats"]["candidates"],
        result["stats"]["create"],
        result["stats"]["update"],
        result["stats"]["done"],
        result["stats"]["conflict"],
    )
    return jsonify(result)


@app.post("/api/search")
def api_search():
    data = json_body()
    query = (data.get("q") or "").strip()
    wiki = (data.get("wiki") or STATE["config"].get("wiki")
            or DEFAULT_CONFIG["wiki"]).strip()
    if len(query) < 2:
        return jsonify({"query": query, "results": [], "wiki": wiki})
    try:
        key = normalize_wiki_url(wiki)
        client = SEARCH_CLIENTS.get(key)
        if client is None:
            client = WikiClient(key)
            SEARCH_CLIENTS[key] = client
        results = client.search_index_details(query, limit=8)
    except WikiError as error:
        logging.info("Search failed for %r: %s", query, error)
        return error_response(error, 502)
    search_url = (
        f"{client.origin}/wiki/Special:Search?search="
        f"{urllib.parse.quote(query)}&ns102=1"
    )
    return jsonify({
        "query": query,
        "wiki": client.origin,
        "results": results,
        "search_url": search_url,
    })


@app.post("/api/page")
def api_page():
    data = json_body()
    try:
        origin = normalize_wiki_url(data.get("origin") or "")
    except WikiError as error:
        return error_response(error, 400)
    index_title = (data.get("index") or "").strip()
    try:
        number = int(data.get("num"))
    except (TypeError, ValueError):
        return jsonify({"error": "পাতার নম্বর ঠিক নয়।", "code": "bad-num"}), 400
    entry = get_book(origin, index_title)
    if entry is None:
        return jsonify({
            "error": "বিশ্লেষণের তথ্য পাওয়া যায়নি; বইটি আবার বিশ্লেষণ করুন।",
            "code": "no-analysis",
        }), 409
    analysis = entry["analysis"]
    pagecount = int(analysis["index"].get("pagecount") or 0)
    if number < 1 or (pagecount and number > pagecount):
        return jsonify({
            "error": "পাতার নম্বর স্ক্যানের সীমার বাইরে।",
            "code": "bad-num",
        }), 400

    existing = entry["pages_by_num"].get(number)
    if existing is not None:
        return jsonify({"page": existing, "existing": True})

    if STATE["client"] is not None and STATE["wiki"] == origin:
        client = STATE["client"]
    else:
        try:
            client = anonymous_client(origin)
        except WikiError as error:
            return error_response(error, 502)

    record = client.manual_page_record(
        number,
        entry.get("by_number", {}).get(number, []),
        base=analysis["index"]["base"],
        style=analysis["stats"]["style"],
        pagecount=pagecount,
        thumb_base=analysis["index"].get("thumb_base"),
        labels=entry.get("labels", {}),
        in_pagelist=number in entry.get("blank_pages", set()),
    )

    with LOCK:
        entry["pages_by_num"][number] = record
        pages = analysis["pages"]
        pages.append(record)
        pages.sort(key=lambda item: item["num"])
        stats = analysis["stats"]
        stats["candidates"] = len(pages)
        kind = record["kind"]
        stats[kind] = stats.get(kind, 0) + 1
        if kind in ("create", "update"):
            stats["pending"] = stats.get("pending", 0) + 1

    logging.info("Manual page added: %s/%s (%s)",
                 index_title, number, record["kind"])
    return jsonify({"page": record, "existing": False})


@app.post("/api/save")
def api_save():
    data = json_body()
    try:
        origin = normalize_wiki_url(data.get("origin") or "")
    except WikiError as error:
        return error_response(error, 400)
    index_title = (data.get("index") or "").strip()
    try:
        number = int(data.get("num"))
    except (TypeError, ValueError):
        return jsonify({"error": "পাতার নম্বর ঠিক নয়।", "code": "bad-num"}), 400
    dry_run = bool(data.get("dry_run", True))
    summary = clean_summary(data.get("summary") or "")
    entry = get_book(origin, index_title)
    if entry is None:
        return jsonify({
            "error": "বিশ্লেষণের তথ্য পাওয়া যায়নি; বইটি আবার বিশ্লেষণ করুন।",
            "code": "no-analysis",
        }), 409
    record = entry["pages_by_num"].get(number)
    if record is None:
        return jsonify({
            "error": "এই পাতাটি বিশ্লেষণের তালিকায় নেই; আবার বিশ্লেষণ করুন।",
            "code": "unknown-page",
        }), 400

    logged_in = bool(STATE["client"] and STATE["user"] and STATE["wiki"] == origin)
    if not dry_run and not logged_in:
        return jsonify({
            "error": "সেভ করার আগে এই উইকিতে লগইন করুন।",
            "code": "login-required",
        }), 401

    if logged_in:
        client = STATE["client"]
        username = STATE["user"] or ""
    else:
        try:
            client = anonymous_client(origin)
        except WikiError as error:
            return error_response(error, 502)
        username = STATE["config"].get("username") or ""

    try:
        result = client.save_blank_page(record, username, summary, dry_run)
    except LoginError as error:
        return error_response(error, 401)
    except WikiError as error:
        if error.code in ("assertuserfailed", "notloggedin"):
            return error_response(
                LoginError("লগইন শেষ হয়ে গেছে; আবার লগইন করুন।",
                           code=error.code), 401)
        logging.info("Save failed for %s/%s: %s", index_title, number, error)
        return error_response(error, 400)

    if result.get("status") == "saved":
        action = result.get("action")
        record.update({
            "kind": "done",
            "level": 0,
            "level_name": "লেখাবিহীন",
            "has_text": False,
            "excerpt": "",
        })
        stats = entry["analysis"]["stats"]
        if action == "create":
            stats["create"] = max(0, stats.get("create", 0) - 1)
        elif action == "update":
            stats["update"] = max(0, stats.get("update", 0) - 1)
        stats["done"] = stats.get("done", 0) + 1
        stats["pending"] = max(0, stats.get("pending", 0) - 1)
        logging.info("Marked %s as without text (%s)", record["title"], action)
        time.sleep(EDIT_DELAY)

    result["stats"] = entry["analysis"]["stats"]
    return jsonify(result)


@app.errorhandler(Exception)
def handle_unexpected(error):
    if isinstance(error, HTTPException):
        return error
    logging.exception("Unhandled error")
    if request.path.startswith("/api/"):
        return jsonify({
            "error": "অপ্রত্যাশিত ত্রুটি ঘটেছে। কনসোলের লগ দেখুন।",
            "code": "server-error",
            "details": str(error),
        }), 500
    return "Internal server error", 500


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def find_port(start: int = 8765) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free local port found")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    port = find_port()
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=try_auto_login, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print()
    print("  Wikisource blank-page tool")
    print(f"  Open: {url}")
    print("  Ctrl+C to stop")
    print()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True,
            use_reloader=False)


if __name__ == "__main__":
    main()

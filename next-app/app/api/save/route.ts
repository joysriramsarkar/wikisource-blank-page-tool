import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/api";
import {
  LoginError,
  WikiClient,
  WikiError,
  buildBlankContent,
  excerpt,
  isBlankContent,
  normalizeWiki,
  parseQuality,
  setQualityZero,
  toAsciiDigits,
} from "@/lib/mediawiki";
import { getSession } from "@/lib/session";

export const maxDuration = 60;

const DEFAULT_SUMMARY = "বট: নির্ঘণ্ট অনুযায়ী লেখাবিহীন পাতা চিহ্নিত করা হলো";

function cleanSummary(value: unknown): string {
  const summary = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  return summary || DEFAULT_SUMMARY;
}

export async function POST(request: Request): Promise<NextResponse> {
  const data = await readJson(request);
  const origin = String(data.origin ?? "");
  const indexTitle = String(data.indexTitle ?? "");
  const pageTitle = String(data.pageTitle ?? "");
  const number = Number(data.num ?? 0);
  const dryRun = data.dryRun !== false;
  const summary = cleanSummary(data.summary);

  if (!origin || !indexTitle || !pageTitle || !Number.isInteger(number) || number < 1) {
    return NextResponse.json(
      { error: "পাতার তথ্য অসম্পূর্ণ।", code: "bad-input" },
      { status: 400 },
    );
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "সেভ করার আগে বট পাসওয়ার্ড দিয়ে লগইন করুন।", code: "login-required" },
      { status: 401 },
    );
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = normalizeWiki(origin);
  } catch (error) {
    return jsonError(error);
  }
  if (session.origin !== normalizedOrigin) {
    return NextResponse.json(
      {
        error: `আপনি ${session.origin}-এ লগইন করা আছেন, কিন্তু বইটি ${normalizedOrigin}-এ।`,
        code: "wrong-wiki",
      },
      { status: 401 },
    );
  }

  try {
    const client = new WikiClient(normalizedOrigin, {
      cookies: session.cookies,
      username: session.username,
      rights: session.rights,
    });
    const site = await client.init();
    const base = indexTitle.split(":").slice(1).join(":");
    if (!base) {
      return NextResponse.json(
        { error: "নির্ঘণ্টের নাম ঠিক নয়।", code: "bad-index" },
        { status: 400 },
      );
    }
    const localizedPrefix = `${site.nsPage}:${base}/`;
    const canonicalPrefix = `Page:${base}/`;
    let suffix: string;
    if (pageTitle.startsWith(localizedPrefix)) {
      suffix = pageTitle.slice(localizedPrefix.length);
    } else if (pageTitle.startsWith(canonicalPrefix)) {
      suffix = pageTitle.slice(canonicalPrefix.length);
    } else {
      return NextResponse.json(
        { error: "পাতাটি এই নির্ঘণ্টের অন্তর্ভুক্ত নয়।", code: "bad-title" },
        { status: 400 },
      );
    }
    if (!/^[0-9০-৯]+$/.test(suffix) || Number(toAsciiDigits(suffix)) !== number) {
      return NextResponse.json(
        { error: "পাতার নম্বর ও শিরোনাম মিলছে না।", code: "bad-title" },
        { status: 400 },
      );
    }

    const current = await client.getPage(pageTitle);
    if (current.redirect) {
      return NextResponse.json({
        status: "skipped",
        message: "পাতাটি একটি পুনর্নির্দেশ; এটি বদলানো হয়নি।",
      });
    }

    let action: "create" | "update";
    let content: string;
    let baserevid: number | null = null;

    if (current.missing) {
      action = "create";
      content = buildBlankContent(session.username);
    } else {
      if (isBlankContent(current.content)) {
        const quality = parseQuality(current.content);
        if (quality.level === 0) {
          return NextResponse.json({
            status: "already_done",
            message: "পাতাটি আগেই লেখাবিহীন (লেভেল ০)।",
          });
        }
      } else {
        return NextResponse.json({
          status: "skipped",
          message: "পাতায় এখন লেখা আছে; নিরাপত্তার জন্য বদলানো হয়নি।",
          excerpt: excerpt(current.content ?? ""),
        });
      }
      action = "update";
      content = setQualityZero(current.content ?? "", session.username);
      baserevid = current.revid;
    }

    if (dryRun) {
      return NextResponse.json({
        status: "dry_run",
        action,
        title: pageTitle,
        level: current.missing ? null : parseQuality(current.content).level,
        content,
        message:
          action === "create"
            ? "নতুন পাতা তৈরি হবে।"
            : "pagequality লেভেল ০ করা হবে।",
      });
    }

    const result = await client.edit(pageTitle, content, summary, {
      create: action === "create",
      baserevid,
    });
    return NextResponse.json({
      status: "saved",
      action,
      title: pageTitle,
      newrevid: result?.newrevid,
      message:
        action === "create"
          ? "নতুন পাতা তৈরি হয়েছে।"
          : "লেখাবিহীন হিসেবে চিহ্নিত হয়েছে।",
    });
  } catch (error) {
    if (error instanceof LoginError) return jsonError(error);
    if (error instanceof WikiError) {
      if (error.code === "assertuserfailed" || error.code === "notloggedin") {
        return NextResponse.json(
          { error: "লগইন শেষ হয়ে গেছে; আবার লগইন করুন।", code: error.code },
          { status: 401 },
        );
      }
    }
    return jsonError(error);
  }
}

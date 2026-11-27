import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/api";
import { DEFAULT_WIKI, LoginError, WikiClient, normalizeWiki } from "@/lib/mediawiki";
import { setSession } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const data = await readJson(request);
  const wiki = String(data.wiki ?? DEFAULT_WIKI);
  const username = String(data.username ?? "").trim();
  const password = String(data.password ?? "");

  if (!username || !password) {
    return NextResponse.json(
      {
        error: "ব্যবহারকারীর নাম ও বট পাসওয়ার্ড দুটোই দিন।",
        code: "missing-credentials",
      },
      { status: 400 },
    );
  }

  try {
    const client = new WikiClient(normalizeWiki(wiki));
    const info = await client.login(username, password);
    if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
      return NextResponse.json(
        {
          error: "সার্ভারে SESSION_SECRET সেট করা হয়নি; ডিপ্লয়মেন্টের এনভায়রনমেন্ট ভেরিয়েবল দেখুন।",
          code: "no-session-secret",
        },
        { status: 500 },
      );
    }
    await setSession({
      origin: client.origin,
      username: info.username,
      rights: info.rights,
      cookies: client.cookies,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof LoginError) return jsonError(error);
    return jsonError(error, 502);
  }
}

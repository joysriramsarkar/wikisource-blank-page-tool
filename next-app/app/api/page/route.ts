import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/api";
import { WikiClient, normalizeWiki } from "@/lib/mediawiki";
import type { PageRecord } from "@/lib/types";

export async function POST(request: Request): Promise<NextResponse> {
  const data = await readJson(request);
  const origin = String(data.origin ?? "");
  const indexTitle = String(data.indexTitle ?? "");
  const base = String(data.base ?? "");
  const style = data.style === "ascii" ? "ascii" : "bn";
  const pageCount = Number(data.pageCount ?? 0);
  const thumbBase = data.thumbBase ? String(data.thumbBase) : null;
  const label = data.label ? String(data.label) : null;
  const inPagelist = Boolean(data.inPagelist);
  const number = Number(data.num ?? 0);

  if (!origin || !indexTitle || !base) {
    return NextResponse.json({ error: "বইয়ের তথ্য অসম্পূর্ণ।", code: "bad-input" }, { status: 400 });
  }
  const baseFromTitle = indexTitle.split(":").slice(1).join(":");
  if (baseFromTitle !== base) {
    return NextResponse.json({ error: "নির্ঘণ্টের নাম মেলেনি।", code: "bad-index" }, { status: 400 });
  }
  if (!Number.isInteger(number) || number < 1) {
    return NextResponse.json({ error: "পাতার নম্বর ঠিক নয়।", code: "bad-num" }, { status: 400 });
  }

  try {
    const client = new WikiClient(normalizeWiki(origin));
    const page: PageRecord = await client.manualPageRecord(number, {
      base,
      style,
      pageCount,
      thumbBase,
      label,
      inPagelist,
    });
    return NextResponse.json({ page });
  } catch (error) {
    return jsonError(error);
  }
}

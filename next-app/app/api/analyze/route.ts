import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/api";
import { DEFAULT_WIKI, WikiClient, inferWikiFromInput, normalizeWiki } from "@/lib/mediawiki";

export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const data = await readJson(request);
  const input = String(data.input ?? "").trim();
  if (!input) {
    return NextResponse.json(
      { error: "বই বা নির্ঘণ্টের নাম লিখুন।", code: "empty-input" },
      { status: 400 },
    );
  }
  const inferred = inferWikiFromInput(input);
  const wiki = normalizeWiki(inferred ?? String(data.wiki ?? DEFAULT_WIKI));

  try {
    const client = new WikiClient(wiki);
    const analysis = await client.analyze(input);
    return NextResponse.json(analysis);
  } catch (error) {
    return jsonError(error);
  }
}

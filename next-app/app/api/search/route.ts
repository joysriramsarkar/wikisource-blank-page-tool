import { NextResponse } from "next/server";
import { jsonError, readJson } from "@/lib/api";
import { DEFAULT_WIKI, WikiClient, normalizeWiki } from "@/lib/mediawiki";

export async function POST(request: Request): Promise<NextResponse> {
  const data = await readJson(request);
  const query = String(data.q ?? "").trim();
  const wiki = normalizeWiki(String(data.wiki ?? DEFAULT_WIKI));

  if (query.length < 2) {
    return NextResponse.json({
      query,
      wiki,
      results: [],
      searchUrl: `${wiki}/wiki/Special:Search?search=${encodeURIComponent(query)}&ns102=1`,
    });
  }

  try {
    const client = new WikiClient(wiki);
    const results = await client.searchIndexDetails(query, 8);
    return NextResponse.json({
      query,
      wiki: client.origin,
      results,
      searchUrl: `${client.origin}/wiki/Special:Search?search=${encodeURIComponent(query)}&ns102=1`,
    });
  } catch (error) {
    return jsonError(error, 502);
  }
}

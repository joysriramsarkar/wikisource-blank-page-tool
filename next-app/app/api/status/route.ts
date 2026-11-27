import { NextResponse } from "next/server";
import { DEFAULT_WIKI } from "@/lib/mediawiki";
import { getSession } from "@/lib/session";
import type { StatusPayload } from "@/lib/types";

export async function GET(): Promise<NextResponse<StatusPayload>> {
  const session = await getSession();
  return NextResponse.json({
    loggedIn: Boolean(session),
    user: session?.username ?? null,
    wiki: session?.origin ?? null,
    config: { wiki: session?.origin ?? DEFAULT_WIKI },
  });
}

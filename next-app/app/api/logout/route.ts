import { NextResponse } from "next/server";
import { WikiClient } from "@/lib/mediawiki";
import { clearSession, getSession } from "@/lib/session";

export async function POST(): Promise<NextResponse> {
  const session = await getSession();
  if (session) {
    try {
      const client = new WikiClient(session.origin, {
        cookies: session.cookies,
        username: session.username,
        rights: session.rights,
      });
      await client.logout();
    } catch {
      // Best effort.
    }
  }
  await clearSession();
  return NextResponse.json({ ok: true });
}

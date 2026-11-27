import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { CompactEncrypt, compactDecrypt } from "jose";
import type { BotSession } from "./types";

const COOKIE_NAME = "ws_session";
const SESSION_HOURS = 8;

function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is required in production");
    }
    return createHash("sha256")
      .update("dev-only-insecure-secret-change-me-before-deploying")
      .digest();
  }
  return createHash("sha256").update(secret).digest();
}

export async function getSession(): Promise<BotSession | null> {
  const store = await cookies();
  const value = store.get(COOKIE_NAME)?.value;
  if (!value) return null;
  try {
    const { plaintext } = await compactDecrypt(value, sessionKey());
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as BotSession;
    if (parsed.v !== 1 || !parsed.origin || !parsed.username) return null;
    if (parsed.exp && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setSession(session: Omit<BotSession, "v" | "iat" | "exp">): Promise<void> {
  const now = Date.now();
  const payload: BotSession = {
    v: 1,
    ...session,
    iat: now,
    exp: now + SESSION_HOURS * 60 * 60 * 1000,
  };
  const jwt = await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(payload)),
  )
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(sessionKey());

  const store = await cookies();
  store.set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

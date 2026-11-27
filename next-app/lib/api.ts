import { NextResponse } from "next/server";
import { LoginError, WikiError } from "./mediawiki";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function jsonError(error: unknown, status = 400): NextResponse {
  if (error instanceof LoginError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: 401 },
    );
  }
  if (error instanceof WikiError) {
    const code = error.code === "ratelimited" ? 429 : status;
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
        suggestions: error.suggestions ?? [],
      },
      { status: code },
    );
  }
  console.error(error);
  return NextResponse.json(
    { error: "অপ্রত্যাশিত ত্রুটি ঘটেছে। সার্ভারের লগ দেখুন।", code: "server-error" },
    { status: 500 },
  );
}

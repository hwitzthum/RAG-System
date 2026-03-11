import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "rag-system-web",
    timestamp: new Date().toISOString(),
  });
}

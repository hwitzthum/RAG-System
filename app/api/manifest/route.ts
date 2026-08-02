// GET /api/manifest — what this app tells the Kommandozentrale it can do.
//
// Excluded from middleware.ts because the dashboard holds no Supabase session;
// it authenticates with DASHBOARD_TOKEN instead, and this route refuses
// outright when the integration is not configured.

import { NextResponse } from "next/server";

import { authenticated, configured } from "@/lib/integration/auth";
import { manifest } from "@/lib/integration/manifest";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!configured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a dashboard." },
      { status: 503 },
    );
  }

  if (!authenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(manifest(), {
    headers: { "cache-control": "no-store" },
  });
}

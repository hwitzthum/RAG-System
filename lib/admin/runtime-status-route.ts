import { NextResponse } from "next/server";
import type { AdminRuntimeStatusResponse } from "@/lib/contracts/api";
import type { AuthUser } from "@/lib/auth/types";

type AuditEvent = {
  action: string;
  actorId: string | null;
  actorRole: string;
  outcome: string;
  resource: string;
  ipAddress: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeStatusRouteDependencies = {
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }>;
  requireAdminAuth(): Promise<
    | { ok: true; user: AuthUser }
    | { ok: false; response: Response }
  >;
  getRuntimeStatus(): Promise<AdminRuntimeStatusResponse>;
  logAuditEvent(input: AuditEvent): void;
};

export async function handleAdminRuntimeStatusGet(input: {
  ipAddress: string;
  dependencies: RuntimeStatusRouteDependencies;
}): Promise<Response> {
  const rl = await input.dependencies.consumeRateLimit(`admin:runtime-status:${input.ipAddress}`, 60, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const authResult = await input.dependencies.requireAdminAuth();
  if (!authResult.ok) {
    input.dependencies.logAuditEvent({
      action: "admin.runtime_status",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "admin",
      ipAddress: input.ipAddress,
      metadata: { reason: "unauthorized" },
    });
    return authResult.response;
  }

  try {
    const status = await input.dependencies.getRuntimeStatus();

    input.dependencies.logAuditEvent({
      action: "admin.runtime_status",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "success",
      resource: "admin",
      ipAddress: input.ipAddress,
      metadata: {
        queuedCount: status.ingestionHealth.queuedCount,
        staleProcessingCount: status.ingestionHealth.staleProcessingCount,
        ingestionContractPassed: status.ingestionContract.passed,
        retrievalCacheContractPassed: status.retrievalCacheContract.passed,
      },
    });

    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    input.dependencies.logAuditEvent({
      action: "admin.runtime_status",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "failure",
      resource: "admin",
      ipAddress: input.ipAddress,
      metadata: { reason: "status_failed", message },
    });
    return NextResponse.json({ error: "Failed to load runtime status" }, { status: 500 });
  }
}

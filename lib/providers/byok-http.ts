import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/request";
import type { ProviderByokStatusResponse } from "@/lib/contracts/api";

const upsertBodySchema = z.object({
  apiKey: z.string().min(1),
});

type ProviderByokRouteConfig = {
  providerLabel: string;
  providerSlug: string;
  getStatus(userId: string): Promise<ProviderByokStatusResponse>;
  upsertUserApiKey(userId: string, apiKeyInput: string): Promise<ProviderByokStatusResponse>;
  deleteUserApiKey(userId: string): Promise<void>;
  isVaultEnabled(): boolean;
};

function providerErrorMessage(config: ProviderByokRouteConfig, action: "load" | "store" | "delete"): string {
  if (action === "load") {
    return `Failed to load ${config.providerLabel} BYOK status`;
  }
  if (action === "store") {
    return `Failed to store ${config.providerLabel} API key`;
  }
  return `Failed to delete ${config.providerLabel} API key`;
}

function vaultDisabledResponse(config: ProviderByokRouteConfig): NextResponse {
  return NextResponse.json(
    {
      error: `${config.providerLabel} BYOK vault is not enabled`,
    },
    { status: 503 },
  );
}

function providerResource(config: ProviderByokRouteConfig): string {
  return `${config.providerSlug}_byok_vault`;
}

function providerAction(config: ProviderByokRouteConfig, operation: "read" | "upsert" | "delete"): string {
  return `${config.providerSlug}.byok.${operation}`;
}

export async function handleByokGet(request: NextRequest, config: ProviderByokRouteConfig) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  if (!config.isVaultEnabled()) {
    return vaultDisabledResponse(config);
  }

  try {
    const status = await config.getStatus(authResult.user.id);
    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: providerAction(config, "read"),
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: providerResource(config),
      ipAddress,
      metadata: {
        reason: "status_lookup_failed",
        message,
      },
    });
    if (message.includes("vault table is missing")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    return NextResponse.json({ error: providerErrorMessage(config, "load") }, { status: 500 });
  }
}

export async function handleByokPut(request: NextRequest, config: ProviderByokRouteConfig) {
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  const rl = await consumeSharedRateLimit(`byok:${config.providerSlug}:write:${authResult.user.id}`, 10, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  if (!config.isVaultEnabled()) {
    return vaultDisabledResponse(config);
  }

  let requestBody: z.infer<typeof upsertBodySchema>;
  try {
    requestBody = upsertBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const status = await config.upsertUserApiKey(authResult.user.id, requestBody.apiKey);
    logAuditEvent({
      action: providerAction(config, "upsert"),
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "success",
      resource: providerResource(config),
      ipAddress,
      metadata: {
        keyLast4: status.keyLast4,
      },
    });
    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: providerAction(config, "upsert"),
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: providerResource(config),
      ipAddress,
      metadata: {
        reason: "upsert_failed",
        message,
      },
    });

    if (message.includes("Invalid")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (message.includes("vault table is missing")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }

    return NextResponse.json({ error: providerErrorMessage(config, "store") }, { status: 500 });
  }
}

export async function handleByokDelete(request: NextRequest, config: ProviderByokRouteConfig) {
  const authResult = await requireAuthWithCsrf(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  const rl = await consumeSharedRateLimit(`byok:${config.providerSlug}:write:${authResult.user.id}`, 10, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  if (!config.isVaultEnabled()) {
    return vaultDisabledResponse(config);
  }

  try {
    await config.deleteUserApiKey(authResult.user.id);
    logAuditEvent({
      action: providerAction(config, "delete"),
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "success",
      resource: providerResource(config),
      ipAddress,
    });
    return NextResponse.json(
      {
        vaultEnabled: true,
        configured: false,
        keyLast4: null,
        updatedAt: null,
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: providerAction(config, "delete"),
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: providerResource(config),
      ipAddress,
      metadata: {
        reason: "delete_failed",
        message,
      },
    });
    if (message.includes("vault table is missing")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    return NextResponse.json({ error: providerErrorMessage(config, "delete") }, { status: 500 });
  }
}

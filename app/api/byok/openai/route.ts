import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import {
  deleteUserOpenAiApiKey,
  getOpenAiByokStatus,
  isOpenAiByokVaultEnabled,
  upsertUserOpenAiApiKey,
} from "@/lib/providers/openai-vault";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

const upsertBodySchema = z.object({
  apiKey: z.string().min(1),
});

function vaultDisabledResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "OpenAI BYOK vault is not enabled",
    },
    { status: 503 },
  );
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  if (!isOpenAiByokVaultEnabled()) {
    return vaultDisabledResponse();
  }

  try {
    const status = await getOpenAiByokStatus(authResult.user.id);
    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: "openai.byok.read",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "openai_byok_vault",
      ipAddress,
      metadata: {
        reason: "status_lookup_failed",
        message,
      },
    });
    if (message.includes("vault table is missing")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    return NextResponse.json({ error: "Failed to load OpenAI BYOK status" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  if (!isOpenAiByokVaultEnabled()) {
    return vaultDisabledResponse();
  }

  let requestBody: z.infer<typeof upsertBodySchema>;
  try {
    requestBody = upsertBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const status = await upsertUserOpenAiApiKey(authResult.user.id, requestBody.apiKey);
    logAuditEvent({
      action: "openai.byok.upsert",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "success",
      resource: "openai_byok_vault",
      ipAddress,
      metadata: {
        keyLast4: status.keyLast4,
      },
    });
    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: "openai.byok.upsert",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "openai_byok_vault",
      ipAddress,
      metadata: {
        reason: "upsert_failed",
        message,
      },
    });

    if (message.includes("Invalid OpenAI API key format")) {
      return NextResponse.json({ error: "Invalid OpenAI API key format" }, { status: 400 });
    }
    if (message.includes("vault table is missing")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }

    return NextResponse.json({ error: "Failed to store OpenAI API key" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const authResult = await requireAuth(request, ["reader", "admin"]);
  const ipAddress = getClientIp(request);

  if (!authResult.ok) {
    return authResult.response;
  }

  if (!isOpenAiByokVaultEnabled()) {
    return vaultDisabledResponse();
  }

  try {
    await deleteUserOpenAiApiKey(authResult.user.id);
    logAuditEvent({
      action: "openai.byok.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "success",
      resource: "openai_byok_vault",
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
      action: "openai.byok.delete",
      actorId: authResult.user.id,
      actorRole: authResult.user.role,
      outcome: "failure",
      resource: "openai_byok_vault",
      ipAddress,
      metadata: {
        reason: "delete_failed",
        message,
      },
    });
    if (message.includes("vault table is missing")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    return NextResponse.json({ error: "Failed to delete OpenAI API key" }, { status: 500 });
  }
}

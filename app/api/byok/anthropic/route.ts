import type { NextRequest } from "next/server";
import { handleByokDelete, handleByokGet, handleByokPut } from "@/lib/providers/byok-http";
import {
  deleteUserAnthropicApiKey,
  getAnthropicByokStatus,
  isAnthropicByokVaultEnabled,
  upsertUserAnthropicApiKey,
} from "@/lib/providers/anthropic-vault";

export const runtime = "nodejs";

const config = {
  providerLabel: "Anthropic",
  providerSlug: "anthropic",
  getStatus: getAnthropicByokStatus,
  upsertUserApiKey: upsertUserAnthropicApiKey,
  deleteUserApiKey: deleteUserAnthropicApiKey,
  isVaultEnabled: isAnthropicByokVaultEnabled,
} as const;

export async function GET(request: NextRequest) {
  return handleByokGet(request, config);
}

export async function PUT(request: NextRequest) {
  return handleByokPut(request, config);
}

export async function DELETE(request: NextRequest) {
  return handleByokDelete(request, config);
}

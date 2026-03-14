import {
  getOpenAiByokStatus,
  isOpenAiByokVaultEnabled,
  deleteUserOpenAiApiKey,
  upsertUserOpenAiApiKey,
} from "@/lib/providers/openai-vault";
import { handleByokDelete, handleByokGet, handleByokPut } from "@/lib/providers/byok-http";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const config = {
  providerLabel: "OpenAI",
  providerSlug: "openai",
  getStatus: getOpenAiByokStatus,
  upsertUserApiKey: upsertUserOpenAiApiKey,
  deleteUserApiKey: deleteUserOpenAiApiKey,
  isVaultEnabled: isOpenAiByokVaultEnabled,
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

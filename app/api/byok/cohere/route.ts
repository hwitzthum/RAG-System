import type { NextRequest } from "next/server";
import { handleByokDelete, handleByokGet, handleByokPut } from "@/lib/providers/byok-http";
import {
  deleteUserCohereApiKey,
  getCohereByokStatus,
  isCohereByokVaultEnabled,
  upsertUserCohereApiKey,
} from "@/lib/providers/cohere-vault";

export const runtime = "nodejs";

const config = {
  providerLabel: "Cohere",
  providerSlug: "cohere",
  getStatus: getCohereByokStatus,
  upsertUserApiKey: upsertUserCohereApiKey,
  deleteUserApiKey: deleteUserCohereApiKey,
  isVaultEnabled: isCohereByokVaultEnabled,
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

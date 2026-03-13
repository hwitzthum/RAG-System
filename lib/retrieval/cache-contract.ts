export const REQUIRED_RETRIEVAL_CACHE_RPCS = [
  "upsert_retrieval_cache_entry",
  "touch_retrieval_cache_entry",
  "prune_retrieval_cache_entries",
] as const;

type RequiredRetrievalCacheRpcName = (typeof REQUIRED_RETRIEVAL_CACHE_RPCS)[number];

type SupabaseError = {
  message: string;
};

type ContractCheckRow = {
  function_name: string;
  is_present: boolean;
};

export type RetrievalCacheContractCheckClient = {
  runCheckRequiredIngestionRpcsRpc(args: {
    required_functions?: string[];
  }): Promise<{ data: ContractCheckRow[] | null; error: SupabaseError | null }>;
};

export async function assertRequiredRetrievalCacheRpcsAvailable(input: {
  client: RetrievalCacheContractCheckClient;
  requiredRpcNames?: readonly RequiredRetrievalCacheRpcName[];
}): Promise<void> {
  const requiredRpcNames = [...(input.requiredRpcNames ?? REQUIRED_RETRIEVAL_CACHE_RPCS)];
  const { data, error } = await input.client.runCheckRequiredIngestionRpcsRpc({
    required_functions: requiredRpcNames,
  });

  if (error) {
    if (error.message.includes("Could not find the function")) {
      throw new Error(
        `Required retrieval cache RPC check_required_ingestion_rpcs is unavailable (${error.message})`,
      );
    }
    throw new Error(`Failed to verify required retrieval cache RPCs: ${error.message}`);
  }

  const rows = data ?? [];
  const available = new Set(rows.filter((row) => row.is_present).map((row) => row.function_name));
  const missing = requiredRpcNames.filter((name) => !available.has(name));

  if (missing.length > 0) {
    throw new Error(`Missing required retrieval cache RPCs: ${missing.join(", ")}`);
  }
}

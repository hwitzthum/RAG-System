import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const REQUIRED_INGESTION_RPCS = [
  "claim_ingestion_jobs",
  "complete_ingestion_job",
  "fail_ingestion_job",
  "create_document_with_ingestion_job",
  "ensure_document_queued_ingestion_job",
  "replace_document_chunks",
  "append_document_chunks",
  "invalidate_retrieval_cache",
  "requeue_dead_letter_document",
  "reconcile_document_status",
  "reconcile_ingestion_job_state",
  "checkpoint_ingestion_job",
  "yield_ingestion_job",
  "smoke_test_ingestion_runtime_contract",
] as const;

type RequiredIngestionRpcName = (typeof REQUIRED_INGESTION_RPCS)[number];

type SupabaseError = {
  message: string;
};

type ContractCheckRow = {
  function_name: string;
  is_present: boolean;
};

type ContractCheckClient = {
  runCheckRequiredIngestionRpcsRpc(args: {
    required_functions?: string[];
  }): Promise<{ data: ContractCheckRow[] | null; error: SupabaseError | null }>;
  runSmokeTestIngestionRuntimeContractRpc(): Promise<{
    data: Array<{ check_name: string; detail: string }> | null;
    error: SupabaseError | null;
  }>;
};

export function createContractCheckClient(supabase: SupabaseClient<Database>): ContractCheckClient {
  return {
    async runCheckRequiredIngestionRpcsRpc(args) {
      const { data, error } = await supabase.rpc("check_required_ingestion_rpcs", args);
      return { data, error };
    },
    async runSmokeTestIngestionRuntimeContractRpc() {
      const { data, error } = await supabase.rpc("smoke_test_ingestion_runtime_contract");
      return { data, error };
    },
  };
}

export async function assertRequiredIngestionRpcsAvailable(input?: {
  client?: ContractCheckClient;
  requiredRpcNames?: readonly RequiredIngestionRpcName[];
}): Promise<void> {
  const requiredRpcNames = [...(input?.requiredRpcNames ?? REQUIRED_INGESTION_RPCS)];
  const client =
    input?.client ??
    createContractCheckClient((await import("@/lib/supabase/admin")).getSupabaseAdminClient());
  const { data, error } = await client.runCheckRequiredIngestionRpcsRpc({
    required_functions: requiredRpcNames,
  });

  if (error) {
    if (error.message.includes("Could not find the function")) {
      throw new Error(`Required ingestion RPC check_required_ingestion_rpcs is unavailable (${error.message})`);
    }
    throw new Error(`Failed to verify required ingestion RPCs: ${error.message}`);
  }

  const rows = data ?? [];
  const available = new Set(rows.filter((row) => row.is_present).map((row) => row.function_name));
  const missing = requiredRpcNames.filter((name) => !available.has(name));

  if (missing.length > 0) {
    throw new Error(`Missing required ingestion RPCs: ${missing.join(", ")}`);
  }

  const { error: smokeError } = await client.runSmokeTestIngestionRuntimeContractRpc();
  if (smokeError) {
    if (smokeError.message.includes("Could not find the function")) {
      throw new Error(
        `Required ingestion RPC smoke_test_ingestion_runtime_contract is unavailable (${smokeError.message})`,
      );
    }
    throw new Error(`Ingestion runtime smoke check failed: ${smokeError.message}`);
  }
}

export { REQUIRED_INGESTION_RPCS };

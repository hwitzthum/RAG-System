import type { Database } from "@/lib/supabase/database.types";

type QueryHistoryDeleteRow = Pick<
  Database["public"]["Tables"]["query_history"]["Row"],
  "id" | "conversation_id"
>;

type QueryHistoryDeleteResult = Promise<{
  data: QueryHistoryDeleteRow[] | null;
  error: { message: string } | null;
}>;

export type DeleteQueryHistorySupabaseClient = {
  from: (table: "query_history") => {
    delete: () => {
      eq: (column: "id", value: string) => {
        eq: (column: "user_id", value: string) => {
          select: (columns: "id,conversation_id") => PromiseLike<{
            data: QueryHistoryDeleteRow[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

export type DeleteQueryHistoryClient = {
  deleteQueryHistory: (input: { entryId: string; userId: string }) => QueryHistoryDeleteResult;
};

export function createDeleteQueryHistoryClient(
  supabase: DeleteQueryHistorySupabaseClient,
): DeleteQueryHistoryClient {
  return {
    async deleteQueryHistory({ entryId, userId }) {
      const result = await supabase
        .from("query_history")
        .delete()
        .eq("id", entryId)
        .eq("user_id", userId)
        .select("id,conversation_id");

      return {
        data: result.data,
        error: result.error,
      };
    },
  };
}

export async function deleteQueryHistoryEntry(input: {
  client: DeleteQueryHistoryClient;
  entryId: string;
  userId: string;
}): Promise<{ id: string; conversationId: string | null } | null> {
  const { data, error } = await input.client.deleteQueryHistory({
    entryId: input.entryId,
    userId: input.userId,
  });

  if (error) {
    throw new Error(`Failed to delete query history entry: ${error.message}`);
  }

  const deletedEntry = data?.[0];
  if (!deletedEntry) {
    return null;
  }

  return {
    id: deletedEntry.id,
    conversationId: deletedEntry.conversation_id,
  };
}

import { createClient } from "@/lib/supabase/client";
import { fail, type ActionResult } from "./result";

// Просьба к сборщику: creatorId null — обойти всех.
export async function requestSync(
  creatorId: string | null,
): Promise<ActionResult<{ id: number; requested_at: string }>> {
  const { data, error } = await createClient()
    .from("sync_requests")
    .insert({ creator_id: creatorId })
    .select("id, requested_at")
    .single();
  if (error) return fail(`Не удалось отправить запрос: ${error.message}`);
  return { ok: true, data };
}

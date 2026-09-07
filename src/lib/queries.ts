import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SyncRun } from "./types";

type Client = SupabaseClient<Database>;

export async function latestRun(supabase: Client): Promise<SyncRun | null> {
  const { data } = await supabase
    .from("sync_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// Незавершённая просьба к сборщику не старше 10 минут — чтобы после перезагрузки
// страницы кнопка снова показала «Запрос отправлен…».
export async function pendingRequestSince(
  supabase: Client,
  creatorId: string | null,
): Promise<string | null> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  let q = supabase
    .from("sync_requests")
    .select("requested_at")
    .is("run_id", null)
    .gte("requested_at", since)
    .order("requested_at", { ascending: false })
    .limit(1);
  q = creatorId === null ? q.is("creator_id", null) : q.eq("creator_id", creatorId);
  const { data } = await q.maybeSingle();
  return data?.requested_at ?? null;
}

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types";
import { supabaseEnv } from "./env";

// Единственный клиент на весь сайт. Сервера нет: сессия живёт в localStorage браузера,
// а данные защищает RLS — публичный ключ ничего сверх неё не даёт.
let client: SupabaseClient<Database> | null = null;

export function createClient(): SupabaseClient<Database> {
  if (client) return client;
  const { url, key } = supabaseEnv();
  client = createSupabaseClient<Database>(url, key);
  return client;
}

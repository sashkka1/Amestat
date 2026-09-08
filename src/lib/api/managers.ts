import { createClient } from "@/lib/supabase/client";
import { fail, UNIQUE_VIOLATION, type ActionResult } from "./result";

// Связь креатор—менеджер. Пишет только админ (RLS).
export async function assignManager(creatorId: string, managerId: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creator_managers")
    .insert({ creator_id: creatorId, manager_id: managerId });
  if (error && error.code !== UNIQUE_VIOLATION) return fail(`Не удалось привязать: ${error.message}`);
  return { ok: true, data: undefined };
}

export async function unassignManager(creatorId: string, managerId: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creator_managers")
    .delete()
    .match({ creator_id: creatorId, manager_id: managerId });
  if (error) return fail(`Не удалось отвязать: ${error.message}`);
  return { ok: true, data: undefined };
}

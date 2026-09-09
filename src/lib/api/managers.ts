import { createClient } from "@/lib/supabase/client";
import { tr } from "@/lib/i18n";
import { fail, UNIQUE_VIOLATION, type ActionResult } from "./result";

// Связь креатор—менеджер. Пишет только админ (RLS).
export async function assignManager(creatorId: string, managerId: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creator_managers")
    .insert({ creator_id: creatorId, manager_id: managerId });
  if (error && error.code !== UNIQUE_VIOLATION)
    return fail(tr("api.managerAssignFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

export async function unassignManager(creatorId: string, managerId: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creator_managers")
    .delete()
    .match({ creator_id: creatorId, manager_id: managerId });
  if (error) return fail(tr("api.managerUnassignFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

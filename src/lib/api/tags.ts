import { createClient } from "@/lib/supabase/client";
import type { Tag } from "@/lib/types";
import { fail, UNIQUE_VIOLATION, type ActionResult } from "./result";

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function normalizeColor(color: string): string | null {
  const c = color.trim();
  return COLOR_RE.test(c) ? c.toUpperCase() : null;
}

export async function createTag(name: string, color: string): Promise<ActionResult<Tag>> {
  const n = name.trim();
  if (!n) return fail("Имя тега пустое");
  const c = normalizeColor(color);
  if (!c) return fail("Цвет должен быть вида #RRGGBB");

  const { data, error } = await createClient()
    .from("tags")
    .insert({ name: n, color: c })
    .select()
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return fail("Тег с таким именем уже есть");
    return fail(`Не удалось создать тег: ${error.message}`);
  }
  return { ok: true, data };
}

export async function updateTag(
  id: string,
  patch: { name?: string; color?: string },
): Promise<ActionResult> {
  const update: { name?: string; color?: string } = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) return fail("Имя тега пустое");
    update.name = n;
  }
  if (patch.color !== undefined) {
    const c = normalizeColor(patch.color);
    if (!c) return fail("Цвет должен быть вида #RRGGBB");
    update.color = c;
  }
  const { error } = await createClient().from("tags").update(update).eq("id", id);
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return fail("Тег с таким именем уже есть");
    return fail(`Не удалось сохранить тег: ${error.message}`);
  }
  return { ok: true, data: undefined };
}

export async function deleteTag(id: string): Promise<ActionResult> {
  const { error } = await createClient().from("tags").delete().eq("id", id);
  if (error) return fail(`Не удалось удалить тег: ${error.message}`);
  return { ok: true, data: undefined };
}

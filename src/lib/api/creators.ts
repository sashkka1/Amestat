import { createClient } from "@/lib/supabase/client";
import { parseHandle } from "@/lib/handle";
import { fail, UNIQUE_VIOLATION, type ActionResult } from "./result";

export async function createCreator(input: {
  raw: string;
  name: string;
  description: string;
  allVideosOurs: boolean;
}): Promise<ActionResult<{ id: string; handle: string }>> {
  const parsed = parseHandle(input.raw);
  if (!parsed) return fail("Не понял ссылку или имя. Нужно: https://www.tiktok.com/@name, @name или name");

  const supabase = createClient();

  // Новый креатор встаёт в конец своего порядка.
  const { data: last } = await supabase
    .from("creators")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (last?.sort_order ?? 0) + 1;

  const displayName = input.name.trim() || parsed.handle;
  const { data, error } = await supabase
    .from("creators")
    .insert({
      platform: parsed.platform,
      handle: parsed.handle,
      display_name: displayName,
      description: input.description.trim(),
      profile_url: parsed.profileUrl,
      sort_order: sortOrder,
      all_videos_ours: input.allVideosOurs,
    })
    .select("id, handle")
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return fail("Такой креатор уже есть");
    return fail(`Не удалось добавить: ${error.message}`);
  }
  return { ok: true, data: { id: data.id, handle: data.handle } };
}

export async function setCreatorAvatar(id: string, avatarUrl: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creators")
    .update({ avatar_url: avatarUrl, avatar_custom: true })
    .eq("id", id);
  if (error) return fail(`Не удалось сохранить картинку: ${error.message}`);
  return { ok: true, data: undefined };
}

export async function updateCreator(
  id: string,
  patch: { display_name: string; description: string; all_videos_ours: boolean },
): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creators")
    .update({
      display_name: patch.display_name.trim(),
      description: patch.description.trim(),
      all_videos_ours: patch.all_videos_ours,
    })
    .eq("id", id);
  if (error) return fail(`Не удалось сохранить: ${error.message}`);
  return { ok: true, data: undefined };
}

export async function deleteCreator(id: string): Promise<ActionResult> {
  const supabase = createClient();

  // Свои картинки в бакете подчищаем; снимки и видео уйдут каскадом в базе.
  const { data: files } = await supabase.storage.from("avatars").list(id);
  if (files && files.length > 0) {
    await supabase.storage.from("avatars").remove(files.map((f) => `${id}/${f.name}`));
  }

  const { error } = await supabase.from("creators").delete().eq("id", id);
  if (error) return fail(`Не удалось удалить: ${error.message}`);
  return { ok: true, data: undefined };
}

// Порядок руками: sort_order = позиция в переданном списке.
export async function saveOrder(ids: string[]): Promise<ActionResult> {
  const supabase = createClient();
  const results = await Promise.all(
    ids.map((id, i) => supabase.from("creators").update({ sort_order: i + 1 }).eq("id", id)),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) return fail(`Порядок не сохранился: ${failed.error.message}`);
  return { ok: true, data: undefined };
}

export async function setCreatorTag(
  creatorId: string,
  tagId: string,
  on: boolean,
): Promise<ActionResult> {
  const supabase = createClient();
  const { error } = on
    ? await supabase.from("creator_tags").insert({ creator_id: creatorId, tag_id: tagId })
    : await supabase.from("creator_tags").delete().match({ creator_id: creatorId, tag_id: tagId });
  if (error && error.code !== UNIQUE_VIOLATION) return fail(`Тег не сохранился: ${error.message}`);
  return { ok: true, data: undefined };
}

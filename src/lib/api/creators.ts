import { createClient } from "@/lib/supabase/client";
import { parseHandle } from "@/lib/handle";
import { tr } from "@/lib/i18n";
import type { Platform } from "@/lib/types";
import { fail, isRaised, UNIQUE_VIOLATION, type ActionResult } from "./result";

export async function createCreator(input: {
  raw: string;
  // Выбор площадки в диалоге: ссылка с доменом всё равно решает сама.
  platform: Platform;
  name: string;
  description: string;
  allVideosOurs: boolean;
}): Promise<ActionResult<{ id: string; handle: string }>> {
  const parsed = parseHandle(input.raw, input.platform);
  if (!parsed) {
    return fail(tr("api.creatorParseError"));
  }

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
    if (error.code === UNIQUE_VIOLATION) return fail(tr("api.creatorExists"));
    return fail(tr("api.creatorAddFailed", { message: error.message }));
  }
  return { ok: true, data: { id: data.id, handle: data.handle } };
}

export async function setCreatorAvatar(id: string, avatarUrl: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("creators")
    .update({ avatar_url: avatarUrl, avatar_custom: true })
    .eq("id", id);
  if (error) return fail(tr("api.creatorAvatarFailed", { message: error.message }));
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
  if (error) return fail(tr("api.creatorSaveFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

// Удаление с карточки креатора — это уход в АРХИВ (миграция v32, владелец 2026-09-15: «при
// удалении статистика не теряется… он просто перестаёт обновляться и числится только в
// архиве»). Видео, снимки и комментарии остаются на месте, картинки в бакете тоже: «Вернуть»
// поднимает креатора со всей историей.
export async function archiveCreator(id: string): Promise<ActionResult> {
  const { error } = await createClient().rpc("set_creator_archived", { p_id: id, p_on: true });
  if (error) {
    return fail(isRaised(error) ? error.message : tr("api.creatorDeleteFailed", { message: error.message }));
  }
  return { ok: true, data: undefined };
}

// «Не обновлять этого креатора» — только руками (миграция v32). Профиль удалён или закрыт,
// обход на нём падает каждый раз, а карточка со старой статистикой нужна на сайте.
export async function setCreatorSyncOff(id: string, on: boolean): Promise<ActionResult> {
  const { error } = await createClient().from("creators").update({ sync_off: on }).eq("id", id);
  if (error) return fail(tr("api.creatorSaveFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

// Корзина в архиве: стереть креатора насовсем вместе со всей историей (миграция v32).
//
// ⚠️ Единственное настоящее удаление во всём сайте. Видео, снимки и комментарии уходят
// каскадом в базе, картинки — здесь: `<id>/` это то, что загрузил владелец, а
// `instagram/<id>/` — аватар и обложки, переложенные сборщиком (их CDN не даёт показывать
// на чужом сайте). Отдаёт handle стёртого: сайту нужно назвать его в сообщении.
export async function purgeCreator(id: string): Promise<ActionResult<string>> {
  const supabase = createClient();
  for (const folder of [id, `instagram/${id}`]) {
    const { data: files } = await supabase.storage.from("avatars").list(folder);
    if (files && files.length > 0) {
      await supabase.storage.from("avatars").remove(files.map((f) => `${folder}/${f.name}`));
    }
  }

  const { data, error } = await supabase.rpc("purge_creator", { p_id: id });
  if (error) {
    return fail(isRaised(error) ? error.message : tr("api.archivePurgeFailed", { message: error.message }));
  }
  return { ok: true, data: String(data ?? "") };
}

// Вернуть креатора из архива (миграция v25). Всё делает база одной функцией: проверяет
// права админа, следит, что двойника с той же парой (площадка, ник) нет, поднимает карточку
// и привязки менеджеров, гасит строку архива.
//
// Стереть запись архива насовсем (миграция v31, владелец 2026-09-15: «в архивных я как
// администратор должен иметь возможность удалять»).
//
// ⚠️ Необратимо и «Вернуть» после этого невозможно: строка архива — единственное, что помнило
// креатора. Видео и снимки стирать не надо, они ушли каскадом ещё при удалении карточки.
// Отдаёт handle стёртого: сайту нужно назвать его в сообщении.
export async function purgeArchivedCreator(id: string): Promise<ActionResult<string>> {
  const { data, error } = await createClient().rpc("purge_archived_creator", { p_id: id });
  if (error) {
    // Свой текст базы («уже нет», «только администратор») показываем как есть.
    return fail(isRaised(error) ? error.message : tr("api.archivePurgeFailed", { message: error.message }));
  }
  return { ok: true, data: String(data ?? "") };
}

// Вернуть из архива. Две дороги, потому что и записи в архиве двух видов (миграция v32):
//   "creator" — карточка с отметкой: гасим отметку, и креатор возвращается СО ВСЕЙ историей;
//   "legacy"  — старая строка `creators_archive` (до v32): заводим карточку заново, истории
//               у неё нет вовсе, её соберёт ближайший обход.
export async function restoreCreator(
  id: string,
  kind: "creator" | "legacy" = "creator",
): Promise<ActionResult> {
  const { error } =
    kind === "legacy"
      ? await createClient().rpc("restore_creator", { p_id: id })
      : await createClient().rpc("set_creator_archived", { p_id: id, p_on: false });
  if (error) {
    // Свой текст базы («уже заведён», «только администратор») показываем как есть.
    return fail(isRaised(error) ? error.message : tr("api.creatorRestoreFailed", { message: error.message }));
  }
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
  if (error && error.code !== UNIQUE_VIOLATION)
    return fail(tr("api.creatorTagFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

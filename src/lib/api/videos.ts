import { createClient } from "@/lib/supabase/client";
import { stateColumns, type VideoState } from "@/lib/video-state";
import { fail, type ActionResult } from "./result";

// Состояние одного видео: «не наше» / «смотрим» / «наше» (миграция v17). Пишутся обе
// колонки разом — `ours` и `watch` порознь смысла не имеют, и «наше» обязано гасить жёлтое.
export async function setVideoState(videoId: string, state: VideoState): Promise<ActionResult> {
  const { error } = await createClient().from("videos").update(stateColumns(state)).eq("id", videoId);
  if (error) return fail(`Не удалось отметить видео: ${error.message}`);
  return { ok: true, data: undefined };
}

// Галочка «все видео наши» включена — все уже собранные видео креатора становятся нашими.
// ⚠️ Близнец setVideoState: жёлтое гасим здесь тоже, иначе у видео остались бы разом
// `ours = true` и `watch = true`, и состояние зависело бы от того, кто читает первым.
export async function markCreatorVideosOurs(creatorId: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("videos")
    .update({ ours: true, watch: false })
    .eq("creator_id", creatorId);
  if (error) return fail(`Видео не отмечены нашими: ${error.message}`);
  return { ok: true, data: undefined };
}

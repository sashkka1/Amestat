import { createClient } from "@/lib/supabase/client";
import { fail, type ActionResult } from "./result";

// Переключатель «наше» у одного видео.
export async function setVideoOurs(videoId: string, on: boolean): Promise<ActionResult> {
  const { error } = await createClient().from("videos").update({ ours: on }).eq("id", videoId);
  if (error) return fail(`Не удалось отметить видео: ${error.message}`);
  return { ok: true, data: undefined };
}

// Галочка «все видео наши» включена — все уже собранные видео креатора становятся нашими.
export async function markCreatorVideosOurs(creatorId: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("videos")
    .update({ ours: true })
    .eq("creator_id", creatorId);
  if (error) return fail(`Видео не отмечены нашими: ${error.message}`);
  return { ok: true, data: undefined };
}

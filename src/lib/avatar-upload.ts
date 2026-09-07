import { createClient } from "@/lib/supabase/client";

const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

// Загрузка картинки из браузера прямо в бакет avatars: <creatorId>/<timestamp>.<ext>.
// Возвращает публичный адрес или текст ошибки.
export async function uploadAvatar(
  creatorId: string,
  file: File,
): Promise<{ url: string } | { error: string }> {
  const ext = ALLOWED[file.type];
  if (!ext) return { error: "Картинка должна быть JPEG, PNG или WebP" };
  if (file.size > AVATAR_MAX_BYTES) return { error: "Картинка больше 5 МБ" };

  const supabase = createClient();
  const path = `${creatorId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) return { error: `Не удалось загрузить картинку: ${error.message}` };

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return { url: data.publicUrl };
}

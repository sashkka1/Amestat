// Адрес и публичный ключ проекта Supabase. Принимаем оба имени ключа:
// новый publishable и старый anon — на клиенте это одно и то же.
export function supabaseEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Не заданы NEXT_PUBLIC_SUPABASE_URL и NEXT_PUBLIC_SUPABASE_ANON_KEY (или NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) — см. .env.local.example",
    );
  }
  return { url, key };
}

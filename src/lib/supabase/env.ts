// Адрес и публичный ключ проекта Supabase. Принимаем оба имени ключа:
// новый publishable и старый anon — на клиенте это одно и то же.

import { tr } from "@/lib/i18n";

export function supabaseEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(tr("api.envMissing"));
  }
  return { url, key };
}

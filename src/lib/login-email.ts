// Логин → адрес для Auth. Писем сайт не шлёт, адрес нужен только как ключ входа:
// логин похож на почту — берём как есть, иначе `<логин>@amestat.invalid`.
// Правило повторено в триггере `handle_new_user` (миграция v3) — расходиться нельзя.

const INVALID_DOMAIN = "@amestat.invalid";

export function slugLogin(login: string): string {
  const s = login.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return s || "user";
}

export function loginToEmail(login: string): string {
  const s = login.trim();
  return s.includes("@") ? s.toLowerCase() : `${slugLogin(s)}${INVALID_DOMAIN}`;
}

// Показывать `.invalid`-адрес незачем: это тот же логин.
export function emailToLogin(email: string): string {
  return email.endsWith(INVALID_DOMAIN) ? email.slice(0, -INVALID_DOMAIN.length) : email;
}

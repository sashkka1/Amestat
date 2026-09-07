// Разбор поля «Ссылка или @имя» в handle без «@» и адрес профиля. Чистая функция.

export type ParsedHandle = { handle: string; profileUrl: string; platform: "tiktok" };

const HANDLE_RE = /^[a-z0-9._]{1,64}$/i;

export function parseHandle(raw: string): ParsedHandle | null {
  let s = raw.trim();
  if (!s) return null;

  // Ссылка: https://www.tiktok.com/@name[/...]  или tiktok.com/@name
  const urlMatch = s.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)*tiktok\.com\/@([^/?#\s]+)/i);
  if (urlMatch) s = urlMatch[1];

  if (s.startsWith("@")) s = s.slice(1);
  s = s.trim();

  if (!HANDLE_RE.test(s)) return null;

  const handle = s.toLowerCase();
  return { handle, profileUrl: `https://www.tiktok.com/@${handle}`, platform: "tiktok" };
}

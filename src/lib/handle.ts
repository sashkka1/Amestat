// Разбор поля «Ссылка или @имя» в handle без «@» и адрес профиля. Чистая функция.

import type { Platform } from "@/lib/types";

export type ParsedHandle = { handle: string; profileUrl: string; platform: Platform };

// Instagram короче TikTok и точно так же допускает точки и подчёркивания.
const HANDLE_RE: Record<Platform, RegExp> = {
  tiktok: /^[a-z0-9._]{1,64}$/i,
  instagram: /^[a-z0-9._]{1,30}$/i,
};

// Ссылка: https://www.tiktok.com/@name[/...] или tiktok.com/@name.
const TIKTOK_URL_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*tiktok\.com\/@([^/?#\s]+)/i;
// Ссылка: https://www.instagram.com/name/[...] — у Instagram имя идёт без «@».
const INSTAGRAM_URL_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*instagram\.com\/([^/?#\s]+)/i;
// Первый сегмент адреса Instagram, который именем профиля не является: ссылка на пост
// или Reels иначе завела бы креатора «p».
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv"]);

// Адрес профиля по имени: годится и для креатора, и для автора комментария.
export function profileUrl(platform: Platform, handle: string): string {
  return platform === "instagram"
    ? `https://www.instagram.com/${handle}/`
    : `https://www.tiktok.com/@${handle}`;
}

// Площадку задаёт ссылка; для голого имени или «@имя» берётся fallback (выбор в диалоге).
export function parseHandle(raw: string, fallback: Platform = "tiktok"): ParsedHandle | null {
  let s = raw.trim();
  if (!s) return null;

  let platform = fallback;
  const tiktokUrl = s.match(TIKTOK_URL_RE);
  const instagramUrl = s.match(INSTAGRAM_URL_RE);
  if (tiktokUrl) {
    platform = "tiktok";
    s = tiktokUrl[1];
  } else if (instagramUrl) {
    if (INSTAGRAM_RESERVED.has(instagramUrl[1].toLowerCase())) return null;
    platform = "instagram";
    s = instagramUrl[1];
  }

  if (s.startsWith("@")) s = s.slice(1);
  s = s.trim();

  if (!HANDLE_RE[platform].test(s)) return null;

  const handle = s.toLowerCase();
  return { handle, profileUrl: profileUrl(platform, handle), platform };
}

// Подпуть сайта на GitHub Pages (`/<repo>`); локально пустой. Тот же, что в next.config.ts —
// next.js подставляет его в <Link>, но собранную руками ссылку (приглашение) надо строить самим.
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

export function siteUrl(path: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${BASE_PATH}${path}`;
}

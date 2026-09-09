"use client";

import { getLang, localeOf, tr } from "@/lib/i18n";
import type { Platform, SyncLogRow } from "@/lib/types";

// Слова ленты «Ход обновления» (владелец, 2026-09-09: «я нажимаю „обновить", и у меня прямо
// видно, как проходит»). Здесь только разбор строк и склейка текста — чтение из базы в
// `lib/api/sync.ts`, вид в `components/sync-log-feed.tsx`.

// Опрос журнала: чаще, чем общий POLL_MS кнопки (15 с). Realtime днём отваливался, а ход
// обхода должен идти на глазах — иначе лента бессмысленна.
export const SYNC_LOG_POLL_MS = 5_000;

// Сборщик метит строки площадкой прямо в тексте: «[tt] @julia: 12 видео». В ленте это
// становится чипом перед строкой, а из текста уходит.
const PLATFORM_PREFIX: Record<string, Platform> = { tt: "tiktok", ig: "instagram" };

// ⚠️ Срезается ровно метка и один пробел за ней: сборщик отбивает вложенные строки лишними
// пробелами («[tt]   ошибка: …» — подстрока креатора), и этот отступ несёт смысл. Лента
// печатает текст как есть (whitespace-pre-wrap), поэтому лишнее не трогаем.
export function splitPlatform(text: string): { platform: Platform | null; text: string } {
  const m = /^\[(tt|ig)\] ?/i.exec(text);
  if (!m) return { platform: null, text };
  return { platform: PLATFORM_PREFIX[m[1].toLowerCase()], text: text.slice(m[0].length) };
}

// Единицы аккаунта: у EnsembleData — свои единицы в день, у Apify — доллары в месяц.
function unitsAmount(value: number, kind: string | null): string {
  const locale = localeOf(getLang());
  if (kind === "usd") {
    return `$${value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const n = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return tr("syncLog.units", { n: n.toLocaleString(locale) });
}

// Хвост строки журнала про деньги: «ED#1 · −12 ед. · осталось 340». Ради него и заведены
// колонки account/units_* (миграция v16): «на каком аккаунте, сколько потратилось, сколько
// осталось». Ничего из этого нет — хвоста тоже нет.
export function unitsText(row: SyncLogRow): string | null {
  const bits: string[] = [];
  if (row.account) bits.push(row.account);
  if (row.units_spent !== null) bits.push(`−${unitsAmount(row.units_spent, row.units_kind)}`);
  if (row.units_left !== null)
    bits.push(tr("syncLog.left", { amount: unitsAmount(row.units_left, row.units_kind) }));
  return bits.length > 0 ? bits.join(" · ") : null;
}

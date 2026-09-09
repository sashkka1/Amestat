"use client";

import { useCallback, useSyncExternalStore } from "react";
import { fmtTime } from "@/lib/format";
import { getLang, localeOf, tr } from "@/lib/i18n";
import { triggerText } from "@/lib/sync-phase";
import type { Platform, SyncLogRow, SyncRun } from "@/lib/types";

// Слова панели «Ход обновления» (владелец, 2026-09-09: «я нажимаю „обновить", и у меня прямо
// видно, как проходит»). Здесь только разбор строк и склейка текста — чтение из базы в
// `lib/api/sync.ts`, вид в `components/sync-log-panel.tsx`.

// Панель свёрнута по умолчанию, а её состояние живёт между заходами — как площадка страниц
// (`lib/platform-filter.ts`) и галочки попапа (`components/sync-options.tsx`).
export const SYNC_LOG_OPEN_KEY = "amestat.synclog.open";

// Опрос журнала: чаще, чем общий POLL_MS кнопки (15 с). Realtime днём отваливался, а ход
// обхода должен идти на глазах — иначе панель бессмысленна.
export const SYNC_LOG_POLL_MS = 5_000;

// Положение панели живёт вне React — тем же приёмом, что площадка страниц: хранилища может
// не быть вовсе (приватный режим), и обращение к нему кидает, поэтому и чтение, и запись в
// try/catch. Значение держим и в памяти: не сохранилось — панель обязана открываться хотя бы
// до перезагрузки, а не захлопываться обратно.
let openNow: boolean | null = null;
const listeners = new Set<() => void>();

function readSavedOpen(): boolean {
  try {
    return window.localStorage.getItem(SYNC_LOG_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeOpen(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getOpen(): boolean {
  if (openNow === null) openNow = readSavedOpen();
  return openNow;
}

// Статические страницы Next печатает заранее, до всякого хранилища: там панель всегда
// свёрнута, а сохранённое положение встаёт сразу после подключения.
function getServerOpen(): boolean {
  return false;
}

export function useSyncLogOpen(): { open: boolean; toggle: () => void } {
  const open = useSyncExternalStore(subscribeOpen, getOpen, getServerOpen);
  const toggle = useCallback(() => {
    const next = !getOpen();
    openNow = next;
    try {
      window.localStorage.setItem(SYNC_LOG_OPEN_KEY, next ? "1" : "0");
    } catch {
      // Не сохранилось — панель всё равно работает, просто до перезагрузки страницы.
    }
    for (const onChange of listeners) onChange();
  }, []);
  return { open, toggle };
}

// Сборщик метит строки площадкой прямо в тексте: «[tt] @julia: 12 видео». В панели это
// становится чипом перед строкой, а из текста уходит.
const PLATFORM_PREFIX: Record<string, Platform> = { tt: "tiktok", ig: "instagram" };

// ⚠️ Срезается ровно метка и один пробел за ней: сборщик отбивает вложенные строки лишними
// пробелами («[tt]   ошибка: …» — подстрока креатора), и этот отступ несёт смысл. Панель
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

// Правая половина заголовка панели: чей обход и где он сейчас. Идущий — «Обход по расписанию ·
// 3 из 10 · @julia · с 13:02»; завершённый — «Обход по расписанию · завершён 13:24, собрано 9,
// с ошибкой 1». Ошибок нет — про них не пишем: строка и так длинная.
export function runHeadText(run: SyncRun): string {
  const parts: string[] = [];
  const trigger = triggerText([run]);
  if (trigger) parts.push(trigger);
  if (run.finished_at) {
    const bad = run.creators_failed > 0 ? tr("syncLog.withErrors", { n: run.creators_failed }) : "";
    parts.push(
      tr("syncLog.finished", { time: fmtTime(run.finished_at), done: run.creators_done }) + bad,
    );
    return parts.join(" · ");
  }
  // Список ещё не отобран — «N из M» сказать нечем, а время начала уже есть.
  if (run.creators_total !== null) {
    const done = Math.min(run.creators_done + run.creators_failed, run.creators_total);
    parts.push(tr("syncLog.progress", { done, total: run.creators_total }));
  }
  // Строка может быть и не хэндлом: сборщик пишет сюда «пауза TikTok до 13:05». Показываем
  // как есть — это и есть ответ на вопрос «что сейчас происходит».
  if (run.current_handles.length > 0) parts.push(run.current_handles.join(" · "));
  parts.push(tr("syncLog.since", { time: fmtTime(run.started_at) }));
  return parts.join(" · ");
}

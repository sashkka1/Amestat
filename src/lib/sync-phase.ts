import type { SyncRequest, SyncRun } from "@/lib/types";

// Общая часть двух мест, которые ждут обход: кнопки «Обновить» над страницей
// (`components/sync-button.tsx`) и очереди строк списка (`lib/use-sync-queue.ts`).
// Правила «в какой фазе просьба» и слова, которыми фаза называется, должны совпадать —
// иначе кнопка и строка того же креатора рассказывают о состоянии разное.

// Покой → в очереди → принято резидентом → идёт обход → снова покой, с новым временем.
export type Phase = "idle" | "queued" | "seen" | "running";

// Страховка на случай, если Realtime не доехал: пока идёт ожидание, перечитываем сами.
export const POLL_MS = 15_000;

// Подписи фаз: строка рядом с кнопкой и подсказка (title) у крутящейся иконки в строке.
export const PHASE_TEXT: Record<Exclude<Phase, "idle">, string> = {
  queued: "В очереди…",
  seen: "Принято, ждёт очереди…",
  running: "Идёт обход…",
};

// База сама написала владельцу в Telegram: просьбу никто не принял за три минуты.
// Формулировки две, потому что места разные: у кнопки — целая строка рядом, места хватает;
// в строке списка — короткая подсказка на иконке.
export const UNAVAILABLE_TEXT =
  "Обновление в настоящий момент недоступно, сообщение отправлено, в ближайшее время обновим";
export const UNAVAILABLE_TITLE = "Обновление сейчас недоступно, сообщение владельцу отправлено";

// Состояние пачки просьб: решает слабейшее звено — пока хоть одна не принята, вся пачка
// в очереди. seenAny и notified смотрят на всю пачку сразу: хоть где-то есть — значит есть.
// Пустая пачка — покой: ждать нечего.
export function stage(reqs: SyncRequest[]): { phase: Phase; seenAny: boolean; notified: boolean } {
  if (reqs.length === 0) return { phase: "idle", seenAny: false, notified: false };
  const phase: Phase = reqs.every((r) => r.taken_at)
    ? "running"
    : reqs.some((r) => !r.seen_at && !r.taken_at)
      ? "queued"
      : "seen";
  return {
    phase,
    seenAny: reqs.some((r) => r.seen_at || r.taken_at),
    notified: reqs.some((r) => r.notified_at),
  };
}

// Чем кончилась пачка обходов — одной строкой для тоста. Не удался хоть один — показываем
// первую же ошибку: разбираться, какой именно креатор упал, идут в карточку.
export function runsResult(runs: SyncRun[]): { ok: boolean; text: string } {
  const bad = runs.find((r) => r.ok === false);
  return bad ? { ok: false, text: bad.error || "Обход не удался" } : { ok: true, text: "Обновлено" };
}

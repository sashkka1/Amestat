import type { SyncRequest, SyncRun, SyncTrigger } from "@/lib/types";

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
  // Слова обхода без счётчиков: пока сборщик не отобрал список, сказать «3 из 10» нечем.
  running: "Обновляем…",
};

// Чей обход идёт (владелец, 2026-09-09: «чтобы понимать, чей обход, когда сам ничего не
// просил»). Подпись серым над строкой хода — и у кнопки, и в подсказке строки списка.
export const TRIGGER_TEXT: Record<SyncTrigger, string> = {
  schedule: "Обход по расписанию",
  catchup: "Догон пропущенного слота",
  retry: "Повтор неудавшихся",
  manual: "Обновление по просьбе",
};

// Подпись пачки: сборщик сводит просьбы в один обход, поэтому берём первый — у сведённых
// обходов повод один и тот же.
export function triggerText(runs: SyncRun[]): string | null {
  const first = runs[0];
  return first ? TRIGGER_TEXT[first.trigger] : null;
}

// Сколько сделано из скольких и кого собираем прямо сейчас (миграция v14):
// «Обновляем 3 из 10 · @npodcast123 · @julia.snkvch, ошибок 2».
// Общее у кнопки «Обновить» и у строк списка — иначе два места считают ход по-разному.
// Пачка складывается: сборщик мог завести по обходу на площадку.
export function progressText(runs: SyncRun[]): string {
  let total = 0;
  let known = false;
  let done = 0;
  let failed = 0;
  const handles: string[] = [];
  for (const r of runs) {
    if (r.creators_total !== null) {
      total += r.creators_total;
      known = true;
    }
    // Сделано — и удачные, и упавшие: обход прошёл их обоих.
    done += r.creators_done + r.creators_failed;
    failed += r.creators_failed;
    for (const h of r.current_handles) if (!handles.includes(h)) handles.push(h);
  }
  // Список ещё не отобран — считать не из чего, остаются прежние слова.
  if (!known) return PHASE_TEXT.running;
  const who = handles.length > 0 ? ` · ${handles.join(" · ")}` : "";
  const bad = failed > 0 ? `, ошибок ${failed}` : "";
  // Пачка могла собраться из обхода со списком и обхода без него — «11 из 10» не пишем.
  return `Обновляем ${Math.min(done, total)} из ${total}${who}${bad}`;
}

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

// Хвост к тосту и к строке состояния: обход шёл с флагом all_videos, значит тексты
// комментариев снимались и у не наших видео (миграция v13). Хвост общий у кнопки «Обновить»
// и у очереди строк списка — как и сам тост.
// ⚠️ Слова не «все видео»: так теперь называется охват списка (миграция v17), и рядом в
// одной строке два одинаковых слова о разном сбивали бы с толку.
export const ALL_VIDEOS_TEXT = " · тексты у не наших";

export function allVideosTail(runs: SyncRun[]): string {
  return runs.some((r) => r.all_videos) ? ALL_VIDEOS_TEXT : "";
}

// Хвост «· только наши»: обход шёл с охватом videos = 'ours' — лишние видео не смотрели
// (миграция v17). Ежедневные обходы идут с 'all', и хвоста у них нет.
export const OURS_ONLY_TEXT = " · только наши";

// ⚠️ Здесь `every`, а не `some`, как у all_videos: сокращённый охват — это обещание «лишнее
// не смотрели», и в пачке, где хоть один обход шёл по всему списку, оно неверно.
export function videosTail(runs: SyncRun[]): string {
  return runs.length > 0 && runs.every((r) => r.videos === "ours") ? OURS_ONLY_TEXT : "";
}

// Чем кончилась пачка обходов — одной строкой для тоста. Не удался хоть один — показываем
// первую же ошибку: разбираться, какой именно креатор упал, идут в карточку.
export function runsResult(runs: SyncRun[]): { ok: boolean; text: string } {
  const bad = runs.find((r) => r.ok === false);
  return bad ? { ok: false, text: bad.error || "Обход не удался" } : { ok: true, text: "Обновлено" };
}

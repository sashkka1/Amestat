import type { SyncDepth, SyncRequest, SyncRun, SyncTrigger } from "@/lib/types";
import { tr } from "@/lib/i18n";

// Общая часть двух мест, которые ждут обход: кнопки «Обновить» над страницей
// (`components/sync-button.tsx`) и очереди строк списка (`lib/use-sync-queue.ts`).
// Правила «в какой фазе просьба» и слова, которыми фаза называется, должны совпадать —
// иначе кнопка и строка того же креатора рассказывают о состоянии разное.
//
// ⚠️ Слова берутся словарём (`lib/i18n`) через `tr`, а не хуком: эти функции зовут и не-React
// модули. Перерисовку при смене языка обеспечивает страница — она подписана через useT.

// Покой → в очереди → принято резидентом → идёт обход → снова покой, с новым временем.
export type Phase = "idle" | "queued" | "seen" | "running";

// Страховка на случай, если Realtime не доехал: пока идёт ожидание, перечитываем сами.
export const POLL_MS = 15_000;

// Подписи фаз: строка рядом с кнопкой и подсказка (title) у крутящейся иконки в строке.
// Слова обхода без счётчиков: пока сборщик не отобрал список, сказать «3 из 10» нечем.
export function phaseText(phase: Exclude<Phase, "idle">): string {
  return phase === "queued"
    ? tr("sync.phaseQueued")
    : phase === "seen"
      ? tr("sync.phaseSeen")
      : tr("sync.phaseRunning");
}

// Чей обход идёт (владелец, 2026-09-09: «чтобы понимать, чей обход, когда сам ничего не
// просил»). Подпись серым над строкой хода — и у кнопки, и в подсказке строки списка.
const TRIGGER_KEY: Record<SyncTrigger, "sync.triggerSchedule" | "sync.triggerCatchup" | "sync.triggerRetry" | "sync.triggerManual"> = {
  schedule: "sync.triggerSchedule",
  catchup: "sync.triggerCatchup",
  retry: "sync.triggerRetry",
  manual: "sync.triggerManual",
};

// Подпись пачки: сборщик сводит просьбы в один обход, поэтому берём первый — у сведённых
// обходов повод один и тот же.
export function triggerText(runs: SyncRun[]): string | null {
  const first = runs[0];
  return first ? tr(TRIGGER_KEY[first.trigger]) : null;
}

// Сколько сделано из скольких и кого собираем прямо сейчас (миграция v14):
// «Обновляем 3 из 10 · @npodcast123 · @julia.snkvch, ошибок 2».
// Общее у кнопки «Обновить» и у строк списка — иначе два места считают ход по-разному.
// Пачка складывается: сборщик мог завести по обходу на площадку.
// ⚠️ Хэндлы в строке — из базы (`current_handles`), и они не переводятся.
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
  if (!known) return tr("sync.phaseRunning");
  const who = handles.length > 0 ? ` · ${handles.join(" · ")}` : "";
  const bad = failed > 0 ? tr("sync.progressErrors", { n: failed }) : "";
  // Пачка могла собраться из обхода со списком и обхода без него — «11 из 10» не пишем.
  return tr("sync.progress", { done: Math.min(done, total), total }) + who + bad;
}

// Насколько обход близок к концу (миграция v24). Владелец, 2026-09-09: «„6 из 10 креаторов“
// ничего не говорит: может, прошли шесть самых быстрых» — поэтому доля считается не по головам,
// а по секундам работы, которые сборщик оценил ДО первого браузера.
// `etaMin` — сколько минут осталось; null — прогноза нет.
export type Work = { percent: number; etaMin: number | null };

// Оценки нет вовсе (обход шёл до миграции или объём не оценился) — null, и тогда полосы не
// рисуем совсем: пустая шкала хуже её отсутствия. Пачка складывается, как и в progressText.
// ⚠️ Прогноз — САМЫЙ ПОЗДНИЙ из пачки: обход кончится, когда закончит последний.
export function workProgress(runs: SyncRun[]): Work | null {
  let total = 0;
  let done = 0;
  let eta: number | null = null;
  for (const r of runs) {
    if (r.work_total === null || r.work_total <= 0) continue;
    total += r.work_total;
    done += r.work_done ?? 0;
    if (r.eta_at) {
      const at = new Date(r.eta_at).getTime();
      if (!Number.isNaN(at) && (eta === null || at > eta)) eta = at;
    }
  }
  if (total <= 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const left = eta === null ? null : Math.max(0, Math.round((eta - Date.now()) / 60_000));
  return { percent, etaMin: left };
}

// Подпись под полосой: «42 % · ещё ≈ 12 мин». Прогноза нет или он меньше минуты — остаётся
// доля и слова «меньше минуты».
export function workText(work: Work): string {
  const tail =
    work.etaMin === null
      ? ""
      : work.etaMin < 1
        ? ` · ${tr("sync.etaSoon")}`
        : ` · ${tr("sync.eta", { min: work.etaMin })}`;
  return tr("sync.percent", { percent: work.percent }) + tail;
}

// Во что обход оценили — строка для администратора: «оценка: список 6 мин, комментарии 20 мин».
// Разбивки нет — null: менеджеру её и не показывают, а до миграции v24 её нет ни у кого.
export function estimateText(runs: SyncRun[]): string | null {
  let list = 0;
  let comments = 0;
  let any = false;
  for (const r of runs) {
    for (const e of r.estimate ?? []) {
      list += e.list;
      comments += e.comments + e.replies;
      any = true;
    }
  }
  if (!any) return null;
  const mins = (seconds: number) => tr("sync.minutes", { n: Math.max(1, Math.round(seconds / 60)) });
  return tr("sync.estimateLine", { list: mins(list), comments: mins(comments) });
}

// База сама написала владельцу в Telegram: просьбу никто не принял за три минуты.
// Формулировки две, потому что места разные: у кнопки — целая строка рядом, места хватает;
// в строке списка — короткая подсказка на иконке.
export function unavailableText(): string {
  return tr("sync.unavailableText");
}

export function unavailableTitle(): string {
  return tr("sync.unavailableTitle");
}

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
export function allVideosText(): string {
  return ` · ${tr("sync.wordTextsNotOurs")}`;
}

export function allVideosTail(runs: SyncRun[]): string {
  return runs.some((r) => r.all_videos) ? allVideosText() : "";
}

// Хвост «· только наши»: обход шёл с охватом videos = 'ours' — лишние видео не смотрели
// (миграция v17). Ежедневные обходы идут с 'all', и хвоста у них нет.
export function oursOnlyText(): string {
  return ` · ${tr("sync.wordOursOnly")}`;
}

// ⚠️ Здесь `every`, а не `some`, как у all_videos: сокращённый охват — это обещание «лишнее
// не смотрели», и в пачке, где хоть один обход шёл по всему списку, оно неверно.
export function videosTail(runs: SyncRun[]): string {
  return runs.length > 0 && runs.every((r) => r.videos === "ours") ? oursOnlyText() : "";
}

// 🔴 Слова глубины живут здесь по одному разу (миграции v7 и v18): их зовут сводка попапа
// («… · месяц · …»), строка состояния кнопки, строка «Обновлено» и тосты очереди строк.
// Разъедутся — два места назовут одну и ту же просьбу по-разному.
const DEPTH_KEY: Record<SyncDepth, "sync.depthAll" | "sync.depthWeek" | "sync.depthMonth" | "sync.depthRange"> = {
  all: "sync.depthAll",
  week: "sync.depthWeek",
  month: "sync.depthMonth",
  range: "sync.depthRange",
};

// Единственный текст про незаполненный период: он же под полями дат в попапе, он же ответ
// requestSync, если просьба с depth = 'range' всё-таки ушла без границ.
export function rangeRequired(): string {
  return tr("sync.rangeRequired");
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

// «01.09–09.09» — концы периода. Год пишется, только если хоть один конец не в нынешнем
// году: внутри года он лишний шум, а «01.09–09.09» прошлого года без него врало бы.
export function rangeWord(from: string | Date, to: string | Date): string | null {
  const f = from instanceof Date ? from : new Date(from);
  const t = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null;
  const year = new Date().getFullYear();
  const withYear = f.getFullYear() !== year || t.getFullYear() !== year;
  const one = (d: Date) => `${two(d.getDate())}.${two(d.getMonth() + 1)}${withYear ? `.${d.getFullYear()}` : ""}`;
  return `${one(f)}–${one(t)}`;
}

// Слово глубины для сводки: у 'range' вместо слова стоят сами даты, а «период» остаётся
// запасным вариантом, пока даты не выбраны.
export function depthWord(
  depth: SyncDepth,
  from?: string | Date | null,
  to?: string | Date | null,
): string {
  if (depth !== "range") return tr(DEPTH_KEY[depth]);
  const w = from && to ? rangeWord(from, to) : null;
  return w ?? tr(DEPTH_KEY.range);
}

// Строка и просьба, и обхода: обе несут depth с границами (миграции v7, v18).
type DepthRow = { depth: SyncDepth; depth_from: string | null; depth_to: string | null };

// Хвост «· месяц» / «· 01.09–09.09» к строке состояния, к «Обновлено» и к тостам.
// ⚠️ У 'all' и 'week' хвоста нет намеренно: так было до v18, и обычный ежедневный обход
// не должен обрастать словами. Пачка сведена сборщиком из одной просьбы — берём первую
// строку, как и triggerText.
export function depthTail(rows: DepthRow[]): string {
  const first = rows[0];
  if (!first || first.depth === "all" || first.depth === "week") return "";
  return ` · ${depthWord(first.depth, first.depth_from, first.depth_to)}`;
}

// 🔴 Слово потолка видео живёт здесь по одному разу — рядом с depthTail и по той же причине
// (миграция v19): его зовут сводка попапа, строка состояния кнопки, строка «Обновлено» и
// тосты очереди строк. null — потолка нет, и слова тоже нет: обычный обход не должен
// обрастать хвостами.
export function maxVideosWord(max: number | null): string | null {
  return max === null ? null : tr("sync.wordMaxVideos", { n: max });
}

// Строка и просьбы, и обхода: обе несут max_videos (миграция v19).
type MaxVideosRow = { max_videos: number | null };

// Хвост «· до 50 видео» к строке состояния, к «Обновлено» и к тостам. Пачка сведена
// сборщиком из одной просьбы — берём первую строку, как depthTail и triggerText.
export function maxVideosTail(rows: MaxVideosRow[]): string {
  const first = rows[0];
  const word = first ? maxVideosWord(first.max_videos) : null;
  return word ? ` · ${word}` : "";
}

// Чем кончилась пачка обходов — одной строкой для тоста. Не удался хоть один — показываем
// первую же ошибку: разбираться, какой именно креатор упал, идут в карточку.
// ⚠️ `run.error` пишет сборщик — этот текст показывается как есть и не переводится.
export function runsResult(runs: SyncRun[]): { ok: boolean; text: string } {
  const bad = runs.find((r) => r.ok === false);
  return bad
    ? { ok: false, text: bad.error || tr("sync.runFailed") }
    : { ok: true, text: tr("sync.updated") };
}

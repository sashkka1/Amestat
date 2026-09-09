// Живой журнал обхода для администратора — таблица `sync_log` (миграция v16).
//
// Владелец, 2026-09-09: на сайте админу нужен ход обновления по мере работы, а не единый текст
// в конце. Поэтому КАЖДАЯ строка лога обхода уезжает в `sync_log` сразу, а прежний
// `sync_runs.log` (весь текст в конце) остаётся как был — он никуда не делся и не заменён.
//
// Как устроено:
//   • строки копятся и уходят пачкой — раз в 2 секунды или когда их набралось 20, и обязательно
//     в конце обхода (`stopSyncLog`). Ход обхода не стоит одного HTTP-запроса на строку;
//   • сбой записи журнала обход НЕ роняет: одна строка в консольный лог на первый сбой, дальше
//     молча. Журнал — это подсказка на сайте, а не результат работы;
//   • `run_id` известен не сразу: строки до создания `sync_runs` (их пара штук) в базу не идут —
//     сирот в журнале быть не должно. Исключение — `logSystem()`: им резидент пишет то, что
//     случилось ВНЕ обхода (например, пропущенный слот), и там `run_id` пуст намеренно;
//   • `account` и `units_*` не заполняются вовсе: провайдеры (EnsembleData, Apify) отложены,
//     и колонки под них пока пустые. `source` у нас бывает только `browser` и `system`.
//
// Уровни (чистая функция `levelOf`, её проверяют тесты):
//   error — ошибка креатора или обхода;
//   warn  — «замечания» владельцу, ожидания и обходные пути;
//   info  — всё остальное.

import { insertMany } from "./db.mjs";

const FLUSH_MS = 2_000;   // как часто сбрасываем накопленное
const BATCH = 20;         // и при каком числе строк не ждём таймера
const TEXT_MAX = 2000;    // одна строка лога бывает длинной (текст письма владельцу целиком)

let runId = null;
let buffer = [];
let timer = null;
let flushing = null;
let failed = 0;
let say = console.log;

// Ошибка креатора или обхода: строка полосы «  ошибка: …» и беды самого обхода.
const ERROR_RE = /(^|\s)ошибка:|обход прерван|обход не начался|обход не удался|не запустился|сорвал/i;
// Замечания владельцу, ожидания и обходные пути — всё, что не беда, но и не «всё хорошо».
const WARN_RE = /замечани|ждём паузу|стоп-экран|капча|признаки истёкшей сессии|не отдал|не открыл|не поднял|не встал|не закрыл|не записал|не спросил|не помеч|не переложил|не скачал|не залил|не удалось/i;
// ⚠️ «не вышло» само по себе на уровень не тянет: итоговые строки шага пишут его ВСЕГДА, и
// «обложек не вышло 0» — это как раз «всё хорошо». Считаем за беду только ненулевой счётчик
// (и строку, где после «не вышло» числа нет вовсе).
const WARN_COUNT_RE = /не вышло(?!\s+0(\D|$))/i;

/**
 * Уровень строки журнала по её тексту. Чистая функция: её проверяют тесты.
 * ⚠️ Сначала `error`, потом `warn`: строка «ошибка: TikTok не отдал список» — это ошибка, а не
 * замечание, хотя под оба правила подходит.
 */
export function levelOf(text) {
  const s = String(text ?? "");
  if (ERROR_RE.test(s)) return "error";
  if (WARN_RE.test(s) || WARN_COUNT_RE.test(s)) return "warn";
  return "info";
}

/** Строка журнала → строка таблицы. Чистая функция: её проверяют тесты. */
export function logRow(text, { runId: id = null, source = "system", handle = null, level = null, at = null } = {}) {
  return {
    run_id: id,
    at: at ?? new Date().toISOString(),
    level: level ?? levelOf(text),
    source: source === "browser" ? "browser" : "system",
    creator_handle: handle ? String(handle).replace(/^@/, "") : null,
    text: String(text ?? "").slice(0, TEXT_MAX),
  };
}

/** Начало обхода: чей это журнал и куда жаловаться, если он сам сломается. */
export function startSyncLog(id, logFn) {
  runId = Number.isFinite(Number(id)) ? Number(id) : null;
  buffer = [];
  failed = 0;
  if (typeof logFn === "function") say = logFn;
}

/**
 * Строка журнала. Зовётся на КАЖДУЮ строку лога обхода — значит быстрая и без ожидания:
 * запись уедет пачкой своим чередом.
 */
export function pushSyncLog(text, { source = "system", handle = null, level = null } = {}) {
  if (runId === null) return;   // обхода ещё (или уже) нет — сирот не пишем
  buffer.push(logRow(text, { runId, source, handle, level }));
  if (buffer.length >= BATCH) {
    void flushSyncLog();
    return;
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushSyncLog();
    }, FLUSH_MS);
    timer.unref?.();
  }
}

/** Сбросить накопленное в базу. Исключений не бросает никогда. */
export async function flushSyncLog() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) return;
  // Две пачки разом не шлём: строки должны лечь в том порядке, в каком случились.
  const previous = flushing ?? Promise.resolve();
  const rows = buffer;
  buffer = [];
  flushing = previous.then(async () => {
    try {
      await insertMany("sync_log", rows);
    } catch (e) {
      // Одна строка на первый сбой: база и так уже под вопросом, а обход из-за журнала не встаёт.
      if (failed++ === 0) say(`журнал обхода не пишется: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  });
  await flushing;
}

/** Конец обхода: дописать остаток и забыть про этот обход. */
export async function stopSyncLog() {
  await flushSyncLog();
  await (flushing ?? Promise.resolve());
  runId = null;
  flushing = null;
}

/**
 * Одна строка ВНЕ обхода (`run_id` пуст): резидент пишет ею то, что случилось между обходами —
 * пропущенный слот, назначенный повтор. Ждать её некому, исключений не бросает.
 */
export async function logSystem(text, { level = null, handle = null } = {}) {
  try {
    await insertMany("sync_log", [logRow(text, { runId: null, source: "system", handle, level })]);
    return true;
  } catch (e) {
    if (failed++ === 0) say(`журнал обхода не пишется: ${String(e?.message ?? e).split("\n")[0]}`);
    return false;
  }
}

// Замечания о проблемах и одно сообщение о них владельцу в Telegram.
//
// Зачем: владелец, 2026-09-08 — «в подобных случаях мне должно смс падать, и в целом при любых
// лагах и проблемах; можно отправлять много уведомлений, позже лишние попрошу скрыть».
// Поэтому порог низкий: замечание ставится везде, где раньше была только строка в логе про
// неудачу, повтор или обходной путь. Лог остаётся как был — замечание идёт вдобавок к нему.
//
// Как устроено:
//   • `notice(код, текст)` копит замечание ТЕКУЩЕГО обхода; в конце обхода `reportRun()` шлёт
//     ОДНО сообщение на все. Слать по сообщению на замечание нельзя: у одного обхода их бывает
//     десятки, и телефон звенел бы без остановки.
//   • Код — короткое латинское слово; в сообщении он стоит в квадратных скобках первым, чтобы
//     владелец потом глушил лишнее списком `AMESTAT_NOTIFY_MUTE` (через запятую, пусто — слать всё).
//   • Замечания резидента (`realtime`, `poll`, `retry`) к обходу не относятся вовсе: они уходят
//     своим сообщением из `watch.mjs`, но не чаще одного в 5 минут НА КОД — Realtime отваливается
//     и возвращается пачками, и без этого правила он один занял бы всю переписку.
//   • Одинаковые замечания склеиваются в «текст (×N)»; длинное режется, всё сообщение — не
//     длиннее 3500 знаков, лишнее считается строкой «… и ещё K».
//
// Словарь кодов (не закрыт, дополняется по месту; тот же список — в README):
//   creator — креатор не собрался           list     — список видео пуст или повтор в новом профиле
//   stop    — стоп-экран или капча          limit    — площадка ограничила запросы
//   photo   — пришлось идти по /photo/      comments — комментарии видео не снялись
//   replies — ответы не снялись             images   — картинка не переложилась
//   session — признаки истёкшей сессии      browser  — браузер не встал с первого раза
//   slow    — креатор собирался дольше 3 минут                db  — база не ответила
//   realtime — Realtime отвалился/вернулся  poll     — просьба поймана опросом, а не Realtime
//   retry   — назначен повтор               run      — обход сорвался целиком
//
// ⚠️ Накопитель обхода один на модуль — и это верно ровно потому, что одновременно идёт не
// больше одного обхода (очередь в `sync.mjs`). Появятся два разом — замечания перемешаются.

import { loadEnv } from "./env.mjs";
import { sendTelegram } from "./telegram.mjs";

const MAX_CHARS = 3500;       // потолок сообщения: у Telegram 4096, остальное — запас
const TAIL_ROOM = 24;         // место под хвост «… и ещё K»
const TEXT_MAX = 300;         // длина одного замечания: одна беда не съедает всё сообщение
const QUIET_MS = 5 * 60_000;  // резидент: не чаще одного сообщения в 5 минут на код

let logLine = console.log;

/** Куда писать строки про сами уведомления. Резидент ставит сюда свой лог с отметкой времени. */
export function setNoticeLog(fn) {
  logLine = typeof fn === "function" ? fn : console.log;
}

/** Глушится ли код списком `AMESTAT_NOTIFY_MUTE`. Настроек нет вовсе — глушить нечего. */
function muted(code) {
  try {
    return loadEnv().notifyMute.includes(String(code).toLowerCase());
  } catch {
    // Нет `.env.local` — это не повод потерять замечание (и не повод упасть здесь).
    return false;
  }
}

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);

/** Кладёт замечание в список, склеивая повторы одного и того же в счётчик. */
function push(list, code, text) {
  const item = { code: String(code), text: clean(text) };
  const same = list.find((x) => x.code === item.code && x.text === item.text);
  if (same) {
    same.count = (same.count ?? 1) + 1;
    return;
  }
  list.push(item);
}

/**
 * Сообщение из заголовка и замечаний: строка на замечание, `[код] текст`.
 * Длиннее потолка — лишнее не режется молча, а считается: «… и ещё K».
 * Чистая функция, отдельно от отправки: её проверяют тесты.
 */
export function buildMessage(head, items, limit = MAX_CHARS) {
  const lines = [String(head)];
  let used = lines[0].length;
  let shown = 0;
  for (const item of items) {
    const line = `[${item.code}] ${item.text}${item.count > 1 ? ` (×${item.count})` : ""}`;
    if (used + 1 + line.length > limit - TAIL_ROOM) break;
    lines.push(line);
    used += 1 + line.length;
    shown++;
  }
  if (shown < items.length) lines.push(`… и ещё ${items.length - shown}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ замечания обхода
let run = null;   // список замечаний текущего обхода; null — обхода нет

/** Начало обхода: прежние замечания забыты, копим заново. */
export function startRun() {
  run = [];
}

/**
 * Замечание текущего обхода.
 * ⚠️ Обхода нет — замечание не идёт никуда, и это нарочно: те же функции зовут тесты и разовые
 * проверки, а звонить владельцу из тестового прогона — последнее, чего он ждёт. Свои беды вне
 * обхода резидент шлёт сам, через `residentNotice`.
 */
export function notice(code, text) {
  if (run === null) return;
  if (muted(code)) return;
  push(run, code, text);
}

/**
 * Конец обхода: одно сообщение владельцу, если замечания были. Отдаёт, ушло ли оно.
 * Исключений не бросает: звонок владельцу не имеет права свалить обход (как и в `telegram.mjs`).
 */
export async function reportRun({ runId = null, trigger = "manual", depth = "all", done = 0, failed = 0, log } = {}) {
  const items = run ?? [];
  run = null;
  if (items.length === 0) return false;
  const head = `Amestat, обход #${runId ?? "?"} (${trigger}, ${depth === "week" ? "неделя" : "всё"}): собрано ${done}, с ошибкой ${failed}`;
  const text = buildMessage(head, items);
  const say = log ?? logLine;
  // Текст уходит и в лог обхода: сообщение в телефоне живёт своей жизнью, а `sync_runs.log`
  // на сайте должен показывать, о чём владельцу сказали и почему.
  say(`замечания (${items.length}) — сообщение владельцу:\n${text}`);
  // `sendTelegram` при неудаче пишет текст в лог сам — второй раз он там не нужен.
  const quiet = (line) => { if (line !== text) say(line); };
  try {
    return await sendTelegram(text, { log: quiet });
  } catch (e) {
    say(`замечания не отправились: ${String(e?.message ?? e).split("\n")[0]}`);
    return false;
  }
}

// ------------------------------------------------------------------ замечания резидента
const lastSentAt = new Map();   // код → когда по нему последний раз уходило сообщение
let waiting = [];
let timer = null;

/**
 * Замечание резидента: уходит своим сообщением, но не чаще одного в 5 минут на код.
 * Пойманное в тишину копится и уезжает пачкой, когда срок кода истечёт.
 */
export function residentNotice(code, text) {
  if (muted(code)) return;
  push(waiting, code, text);
  flush();
}

function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const now = Date.now();
  const ready = [], keep = [];
  for (const item of waiting) {
    if (now - (lastSentAt.get(item.code) ?? 0) >= QUIET_MS) ready.push(item);
    else keep.push(item);
  }
  waiting = keep;
  if (ready.length > 0) {
    for (const item of ready) lastSentAt.set(item.code, now);
    const total = ready.reduce((n, i) => n + (i.count ?? 1), 0);
    const text = buildMessage(`Amestat, резидент: замечаний ${total}`, ready);
    logLine(`замечания резидента (${ready.length}) — сообщение владельцу:\n${text}`);
    const quiet = (line) => { if (line !== text) logLine(line); };
    // Ждать отправку некому: резидент живёт дальше, а неудача и так уйдёт строкой в лог.
    Promise.resolve(sendTelegram(text, { log: quiet }))
      .catch((e) => logLine(`замечания резидента не отправились: ${String(e?.message ?? e).split("\n")[0]}`));
  }
  if (waiting.length > 0) {
    const wait = Math.min(...waiting.map((i) => QUIET_MS - (now - (lastSentAt.get(i.code) ?? 0))));
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, Math.max(1_000, wait));
    // Таймер не держит процесс: разовый запуск (`run.mjs`) должен выходить сразу.
    timer.unref?.();
  }
}

// Замечания о проблемах и одно сообщение о них владельцу в Telegram.
//
// Зачем: владелец, 2026-09-08 — «в подобных случаях мне должно смс падать, и в целом при любых
// лагах и проблемах; можно отправлять много уведомлений, позже лишние попрошу скрыть».
// Поэтому порог низкий: замечание ставится везде, где раньше была только строка в логе про
// неудачу, повтор или обходной путь. Лог остаётся как был — замечание идёт вдобавок к нему.
//
// ⚠️ Правка 2026-09-08, вечер: порог остался низким, но шаблонное больше не уходит. Владелец
// за 12 минут получил семь сообщений подряд — мигание Realtime, одиночный `fetch failed` после
// сна ноутбука, уже отправленное «повтор назначен» и два письма об одном обходе. Правила
// тишины ниже — ответ на это; смысл один: письмо уходит, когда случилось что-то, чего владелец
// ещё не знает.
//
// Как устроено:
//   • `notice(код, текст)` копит замечание ТЕКУЩЕГО обхода; в конце обхода `reportRun()` шлёт
//     ОДНО сообщение на все. Слать по сообщению на замечание нельзя: у одного обхода их бывает
//     десятки, и телефон звенел бы без остановки.
//   • Код — короткое латинское слово; в сообщении он стоит в квадратных скобках первым, чтобы
//     владелец потом глушил лишнее списком `AMESTAT_NOTIFY_MUTE` (через запятую, пусто — слать всё).
//   • Замечания резидента (`realtime`, `poll`, `retry`, `db`) к обходу не относятся вовсе: они
//     уходят своим сообщением из `watch.mjs` — ОДНИМ на все коды и не чаще раза в 5 минут, причём
//     первое письмо не раньше чем через минуту после первого замечания: пачка должна собраться.
//     Прежнее окно «5 минут на код» и давало три письма за пять секунд с разными кодами.
//   • Прогрев (`startWarmup`): первые 90 секунд после старта резидента и после сна компьютера
//     замечания `realtime`/`db`/`poll` не копятся вовсе — только лог. Сеть после пробуждения
//     поднимается не мгновенно, и её первый отказ бедой не является.
//   • Замечание `creator` слово в слово не уходит чаще раза в сутки (`squashKnown`): демо-креаторы
//     не находятся каждый обход, и их четыре строки владелец уже читал. Вместо них — одна строка
//     «ещё N креаторов с прежними ошибками». Память переживает перезапуск: `logs/notices-state.json`.
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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, collectorDir } from "./env.mjs";
import { sendTelegram } from "./telegram.mjs";

const MAX_CHARS = 3500;       // потолок сообщения: у Telegram 4096, остальное — запас
const TAIL_ROOM = 24;         // место под хвост «… и ещё K»
const TEXT_MAX = 300;         // длина одного замечания: одна беда не съедает всё сообщение
const QUIET_MS = 5 * 60_000;  // резидент: не чаще одного письма в 5 минут — окно одно на все коды
const GATHER_MS = 60_000;     // и не раньше минуты после первого замечания: пачка должна собраться

export const WARMUP_MS = 90_000;              // прогрев после старта и после сна
export const JUMP_MS = 3 * 60_000;            // между тиками больше — компьютер спал
export const DB_STREAK = 3;                   // база молчит третий раз подряд — вот тогда пишем
export const REALTIME_DOWN_MS = 5 * 60_000;   // подписки нет дольше — это уже не мигание
export const SAME_ERROR_MS = 24 * 60 * 60_000; // та же ошибка того же креатора — раз в сутки

// Коды, которые молчат на прогреве: они все про сеть, а сеть после сна встаёт не сразу.
const WARM_CODES = new Set(["realtime", "db", "poll"]);
const STATE_FILE = resolve(collectorDir, "logs", "notices-state.json");

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

// ------------------------------------------------------------------ правила тишины (чистые)
// Ниже — только расчёты: ни таймеров, ни отправки, ни файлов. Их проверяют тесты
// (`notices.test.mjs`) на поддельных часах, а стороны с побочными действиями зовут их у себя.

/**
 * Когда пачке замечаний резидента можно уехать: не раньше минуты после первого замечания
 * и не раньше пяти минут после прошлого письма. Отдаёт отметку времени.
 */
export function sendAt(now, { lastSentAt = 0, firstQueuedAt = null, quietMs = QUIET_MS, gatherMs = GATHER_MS } = {}) {
  const from = firstQueuedAt ?? now;
  return Math.max(from + gatherMs, lastSentAt === 0 ? 0 : lastSentAt + quietMs);
}

/**
 * Счётчик неудач подряд. Одиночный `fetch failed` — не беда: сеть моргнула, следующая минута
 * всё поправит. Беда — когда не выходит `limit` раз подряд, и сказать об этом надо один раз.
 * `state` — `{ fails, told }`; `say` — `"down"`, `"up"` или `null`.
 */
export function streak(state, ok, limit = DB_STREAK) {
  const fails = state?.fails ?? 0;
  const told = state?.told ?? false;
  if (ok) {
    return { state: { fails: 0, told: false }, say: told ? "up" : null };
  }
  const next = { fails: fails + 1, told: told || fails + 1 >= limit };
  return { state: next, say: !told && next.told ? "down" : null };
}

/** Сколько минут проспал компьютер: между тиками прошло больше `jumpMs`. Не спал — 0. */
export function sleepGap(prevTickAt, now, jumpMs = JUMP_MS) {
  if (!prevTickAt) return 0;
  const gap = now - prevTickAt;
  return gap > jumpMs ? Math.round(gap / 60_000) : 0;
}

/** Идёт ли ещё прогрев (замечания о сети — только в лог). */
export function isWarm(now, until) {
  return Boolean(until) && now < until;
}

/**
 * Шаг состояния Realtime по событию подписки. `state` — `{ downSince, told }`.
 * Мигание (отвалился и вернулся, пока сторож не сработал) не даёт ни слова: `say` — `null`.
 * Вернулась после долгого перерыва — `{ kind: "up", minutes }`.
 */
export function realtimeStep(state, ok, now) {
  const downSince = state?.downSince ?? null;
  const told = state?.told ?? false;
  if (!ok) {
    // Второй CHANNEL_ERROR подряд отсчёт не начинает заново: перерыв идёт с первого.
    return { state: { downSince: downSince ?? now, told }, say: null };
  }
  const say = told ? { kind: "up", minutes: Math.max(1, Math.round((now - (downSince ?? now)) / 60_000)) } : null;
  return { state: { downSince: null, told: false }, say };
}

/** Сторож пяти минут сработал: подписки всё ещё нет — вот теперь это событие. */
export function realtimeDown(state, now, downMs = REALTIME_DOWN_MS) {
  const downSince = state?.downSince ?? null;
  if (downSince === null || state?.told || now - downSince < downMs) return { state: { ...state }, say: null };
  return { state: { downSince, told: true }, say: { kind: "down", since: downSince } };
}

/**
 * Убирает из письма обхода замечания `creator`, которые слово в слово уходили за последние сутки:
 * демо-креаторы не находятся каждый обход, и владелец эти четыре строки уже читал.
 * Отдаёт новый список (с итоговой строкой вместо убранных), обновлённую память и число убранных.
 * ⚠️ Только `creator`: у остальных кодов текст меняется от раза к разу и склеивать нечего.
 */
export function squashKnown(items, memory, now, ttl = SAME_ERROR_MS) {
  const next = {};
  // Заодно чистим память: запись старше суток ничего не глушит, а файл растить незачем.
  for (const [key, at] of Object.entries(memory ?? {})) {
    if (Number.isFinite(at) && now - at < ttl) next[key] = at;
  }
  const kept = [];
  let suppressed = 0;
  for (const item of items) {
    if (item.code !== "creator") {
      kept.push(item);
      continue;
    }
    const key = `${item.code}|${item.text}`;
    if (next[key] !== undefined) {
      suppressed += item.count ?? 1;
      continue;
    }
    next[key] = now;
    kept.push(item);
  }
  if (suppressed > 0) {
    kept.push({ code: "creator", text: `ещё ${suppressed} креаторов с прежними ошибками (см. прошлые письма)` });
  }
  return { items: kept, memory: next, suppressed };
}

// ------------------------------------------------------------------ память между запусками
// Что уже уходило владельцу, переживает перезапуск: иначе резидент, поднятый заново (а он
// поднимается после каждого сна), слал бы те же четыре строки про демо-креаторов опять.

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    // Файла нет или он испорчен — это не беда: память просто пустая.
    return {};
  }
}

function saveState(state) {
  try {
    mkdirSync(resolve(collectorDir, "logs"), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    // Не записалось — письма пойдут чаще, чем надо, но работа не встаёт.
    logLine(`память уведомлений не записалась: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

// ------------------------------------------------------------------ прогрев
let warmUntil = 0;

/**
 * Прогрев: `WARMUP_MS` замечания о сети (`realtime`, `db`, `poll`) идут только в лог.
 * Зовётся при старте резидента и когда часы «прыгнули» — компьютер спал.
 */
export function startWarmup(reason = "старта", ms = WARMUP_MS, now = Date.now()) {
  warmUntil = now + ms;
  logLine(`прогрев после ${reason}: ${Math.round(ms / 1000)} с замечания о сети идут только в лог`);
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
export async function reportRun({ runId = null, trigger = "manual", depth = "all", done = 0, failed = 0, slotLabel = null, log } = {}) {
  const all = run ?? [];
  run = null;
  if (all.length === 0) return false;
  const now = Date.now();
  const state = loadState();
  const { items, memory, suppressed } = squashKnown(all, state.creatorErrors ?? {}, now);
  saveState({ ...state, creatorErrors: memory });
  // `slotLabel` ставит только неудавшийся повтор: отдельного письма «не удался дважды» больше
  // нет (владелец получал два письма об одном событии), и эта строка — всё, что от него осталось.
  const head = `Amestat, обход #${runId ?? "?"} (${trigger}, ${depth === "week" ? "неделя" : "всё"}): собрано ${done}, с ошибкой ${failed}`
    + (slotLabel ? `\nвторая неудача подряд после слота ${slotLabel}` : "");
  const text = buildMessage(head, items);
  const say = log ?? logLine;
  // Текст уходит и в лог обхода: сообщение в телефоне живёт своей жизнью, а `sync_runs.log`
  // на сайте должен показывать, о чём владельцу сказали и почему.
  say(`замечания (${items.length}${suppressed > 0 ? `, прежних за сутки не повторено ${suppressed}` : ""}) — сообщение владельцу:\n${text}`);
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
// Окно ОДНО на все коды, а не на код: три письма за пять секунд с разными кодами (`realtime`,
// `db`, `retry` в логе 2026-09-08) — ровно то, чего владелец просил не делать.
let waiting = [];
let firstQueuedAt = null;   // когда легло первое замечание пачки
let lastSentAt = 0;         // когда ушло прошлое письмо резидента
let timer = null;

/**
 * Замечание резидента: копится и уходит пачкой в одном письме — не чаще раза в 5 минут и не
 * раньше минуты после первого замечания пачки.
 * На прогреве (первые 90 с после старта и после сна) замечания о сети не копятся вовсе.
 */
export function residentNotice(code, text, now = Date.now()) {
  if (muted(code)) return;
  if (isWarm(now, warmUntil) && WARM_CODES.has(String(code))) {
    logLine(`прогрев: [${code}] ${clean(text)} — только в лог`);
    return;
  }
  push(waiting, code, text);
  if (firstQueuedAt === null) firstQueuedAt = now;
  schedule(now);
}

function schedule(now = Date.now()) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (waiting.length === 0) return;
  const due = sendAt(now, { lastSentAt, firstQueuedAt });
  if (due <= now) {
    flush(now);
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    flush(Date.now());
  }, Math.max(1_000, due - now));
  // Таймер не держит процесс: разовый запуск (`run.mjs`) должен выходить сразу.
  timer.unref?.();
}

function flush(now = Date.now()) {
  const ready = waiting;
  waiting = [];
  firstQueuedAt = null;
  if (ready.length === 0) return;
  lastSentAt = now;
  const total = ready.reduce((n, i) => n + (i.count ?? 1), 0);
  const text = buildMessage(`Amestat, резидент: замечаний ${total}`, ready);
  logLine(`замечания резидента (${ready.length}) — сообщение владельцу:\n${text}`);
  const quiet = (line) => { if (line !== text) logLine(line); };
  // Ждать отправку некому: резидент живёт дальше, а неудача и так уйдёт строкой в лог.
  Promise.resolve(sendTelegram(text, { log: quiet }))
    .catch((e) => logLine(`замечания резидента не отправились: ${String(e?.message ?? e).split("\n")[0]}`));
}

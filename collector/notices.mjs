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
//   • Мягкие признаки истёкшей сессии («собралось, но пахнет входом») письмом не бывают вовсе:
//     они копятся `sessionHint()` и уходят ОДНОЙ строкой в лог на обход и площадку. Прежде
//     каждая публикация ставила своё замечание, и обход по восьми креаторам давал их десятками
//     (владелец, 2026-09-08). В письмо `[session]` попадает только тогда, когда из-за входа
//     что-то НЕ собралось — там по-прежнему `notice("session", …)` и брошенная ошибка.
//   • Замечание `creator` слово в слово не уходит чаще раза в сутки (`squashKnown`): демо-креаторы
//     не находятся каждый обход, и их четыре строки владелец уже читал. Вместо них — одна строка
//     «ещё N креаторов с прежними ошибками». Память переживает перезапуск: `logs/notices-state.json`.
//   • Одинаковые замечания склеиваются в «текст (×N)»; длинное режется, всё сообщение — не
//     длиннее 3500 знаков, лишнее считается строкой «… и ещё K».
//   • Язык (владелец, 2026-09-17): замечания копятся, сравниваются и пишутся в лог ПО-АНГЛИЙСКИ,
//     а в Telegram уходит русский текст того же письма — `telegram-ru.mjs`, последним шагом.
//
// Словарь кодов (не закрыт, дополняется по месту; тот же список — в README):
//   creator — креатор не собрался           list     — TikTok не отдал список (защита по адресу)
//   stop    — стоп-экран или капча          limit    — площадка ограничила запросы
//   photo   — пришлось идти по /photo/      comments — комментарии видео не снялись
//   replies — ответы не снялись             images   — картинка не переложилась
//   missing — пришло меньше, чем лежит в базе: ноль публикаций или недобор видео
//   direct  — прямой запрос не дал, пошли браузером (данные в итоге собраны)
//   session — из-за входа что-то не собралось (мягкие признаки — `sessionHint`, только лог)
//   browser — браузер не встал с первого раза
//   slow    — креатор собирался дольше 3 минут                db  — база не ответила
//   realtime — Realtime отвалился/вернулся  poll     — просьба поймана опросом, а не Realtime
//   retry   — назначен повтор               run      — обход сорвался целиком
//
// 🔴 Какие из них дают письмо — решает `LOST_CODES` ниже, и список там ЗАКРЫТЫЙ наоборот:
// письмо не дают только перечисленные в `KEPT_CODES`, всё остальное беспокоит владельца
// (владелец, 2026-09-16: «боязливая система… при любом странном поведении сразу пинговать»).
//
// ⚠️ Накопитель обхода один на модуль — и это верно ровно потому, что одновременно идёт не
// больше одного обхода (очередь в `sync.mjs`). Появятся два разом — замечания перемешаются.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, collectorDir } from "./env.mjs";
import { sendTelegram } from "./telegram.mjs";
// ⚠️ `scope.mjs` ни от кого не зависит вовсе — кольца импортов отсюда не будет.
import { depthLabel } from "./scope.mjs";
// Письмо в Telegram — по-русски (владелец, 2026-09-17), лог и память повторов — по-английски.
import { itemsRu, moreRu, residentHeadRu, runHeadRu } from "./telegram-ru.mjs";

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
 * Длиннее потолка — лишнее не режется молча, а считается: «… and K more» в логе,
 * «… и ещё K» в письме (`more` — хвост словами).
 * Чистая функция, отдельно от отправки: её проверяют тесты.
 */
export function buildMessage(head, items, limit = MAX_CHARS, more = (k) => `… and ${k} more`) {
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
  if (shown < items.length) lines.push(more(items.length - shown));
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

/**
 * Пропавшие видео: о ком письмо ещё не уходило, а о ком уже.
 *
 * Правило владельца (2026-09-16): «если один раз заподозрил, что видео удалено, — пишет это в
 * сообщении и в логе, но повторно на то же видео, если оно снова не нашлось, сообщение писаться
 * не должно: если оно удалено, значит, один раз отправляем и всё».
 * Поэтому память здесь не суточная, как у `squashKnown`: удалённое видео через сутки само не
 * вернётся, и напоминать о нём незачем. Живёт запись ровно до тех пор, пока видео снова не
 * встретится в списке, — тогда её стирает `forgetReturned` (владелец, тот же день: «было удалено,
 * потом возвращено и снова удалено — писать»).
 *
 * `ids` — id пропавших на этом обходе; `memory` — `{ id: когда впервые написали }`.
 * Отдаёт `{ fresh, known, memory }`: `fresh` — о них пишем сейчас, `known` — о них уже писали
 * (только лог), `memory` — новая память с добавленными `fresh`.
 * Чистая функция: её проверяют тесты.
 */
export function splitVanished(ids, memory, now = Date.now()) {
  const next = { ...(memory ?? {}) };
  const fresh = [], known = [];
  for (const raw of ids ?? []) {
    if (raw === null || raw === undefined) continue;
    const id = String(raw);
    if (next[id] !== undefined) {
      known.push(id);
    } else {
      next[id] = now;
      fresh.push(id);
    }
  }
  return { fresh, known, memory: next };
}

/**
 * Видео, о пропаже которых уже писали, снова встретились в списке — забыть их.
 * Владелец, 2026-09-16: «если видео было удалено, потом возвращено и потом снова удалено — писать».
 * Без этого вернувшееся видео так и числилось бы «о нём уже писали», и вторая пропажа прошла бы
 * молча.
 * 🔴 Годится ЛЮБОЙ список, даже недочитанный: пропажу по нему судить нельзя, а вот присутствие —
 * можно, видео в списке точно есть в профиле.
 * `memory` — `{ id: когда впервые написали }`; `seenIds` — id всего, что пришло в списке.
 * Отдаёт `{ memory, returned }`: новая память и id вернувшихся (порядок — как в памяти).
 * Чистая функция: её проверяют тесты.
 */
export function forgetReturned(memory, seenIds) {
  const seen = new Set();
  for (const id of seenIds ?? []) if (id !== null && id !== undefined) seen.add(String(id));
  const next = {};
  const returned = [];
  for (const [id, at] of Object.entries(memory ?? {})) {
    if (seen.has(id)) returned.push(id);
    else next[id] = at;
  }
  return { memory: next, returned };
}

/**
 * «Список кончился раньше, чем обещал профиль» — одно письмо на эпизод.
 *
 * Владелец, 2026-09-17: «если один раз пришло, то второй не нужно». Прежде это замечание глушилось
 * сутками по тексту (`squashKnown`) и приходило каждый день, пока расхождение стоит; а новое видео
 * меняет оба числа в тексте — и письмо уходило бы ещё и в тот же день.
 * Эпизод кончается, когда законченный список догнал профиль: память стирается, и новое расхождение
 * снова даёт письмо — то же правило, что у пропавших видео (`forgetReturned`).
 *
 * `memory` — `{ creatorId: когда впервые написали }`; `short` — расхождение есть на этом обходе;
 * `healed` — список законченный и не короче профиля. Ни то ни другое (список недочитан, профиль
 * молчит) — память не трогается: судить не по чему.
 * Отдаёт `{ say, memory }`. Чистая функция: её проверяют тесты.
 */
export function shortOnce(memory, key, { short = false, healed = false, now = Date.now() } = {}) {
  const next = { ...(memory ?? {}) };
  const id = String(key);
  if (short) {
    if (next[id] !== undefined) return { say: false, memory: next };
    next[id] = now;
    return { say: true, memory: next };
  }
  if (healed) delete next[id];
  return { say: false, memory: next };
}

export const SESSION_STALE_MS =3 * 24 * 60 * 60_000;   // сессию не продлевали трое суток — тревога
export const SESSION_SOON_MS = 14 * 24 * 60 * 60_000;   // до конца её срока меньше двух недель

/**
 * Сторож входа по сроку жизни cookie `sessionid`.
 *
 * Зачем (разбор 2026-09-16): пометки `login_required` в ответах Instagram сигналом быть не могут —
 * они горят и при живой сессии. А вот срок cookie не врёт: Instagram продлевает `sessionid`
 * КАЖДЫМ удачным заходом, и в тот же день было видно, как `expires` уехал на год вперёд прямо
 * во время обхода. Перестал двигаться — значит площадка нас больше вошедшими не считает, и
 * сказать об этом надо ДО того, как пропадут данные.
 *
 * `state` — `{ expiresMs, movedAt, told }` (told: 'stale' | 'soon' | null); `expiresMs` — срок
 * cookie сейчас, `null` — cookie нет вовсе (этот случай ловят сами коллекторы, сторож молчит).
 * Отдаёт `{ state, say }`, где `say` — `null` или `{ kind: 'stale'|'soon', days }`.
 * Каждая беда говорится ОДИН раз: пока причина та же, письма больше не будет, а продлившаяся
 * cookie сбрасывает память и возвращает сторожу голос.
 * Чистая функция: её проверяют тесты.
 */
export function sessionWatch(state, { expiresMs = null, now = Date.now(), staleMs = SESSION_STALE_MS, soonMs = SESSION_SOON_MS } = {}) {
  const prev = state ?? {};
  const was = Number.isFinite(Number(prev.expiresMs)) ? Number(prev.expiresMs) : null;
  const told = prev.told ?? null;
  const at = Number.isFinite(Number(expiresMs)) && Number(expiresMs) > 0 ? Number(expiresMs) : null;
  if (at === null) return { state: { ...prev }, say: null };
  // Первая встреча или cookie продлилась — запоминаем и молчим: это и есть здоровье.
  if (was === null || at > was) return { state: { expiresMs: at, movedAt: now, told: null }, say: null };

  const movedAt = Number.isFinite(Number(prev.movedAt)) ? Number(prev.movedAt) : now;
  const next = { expiresMs: at, movedAt, told };
  const days = (ms) => Math.max(1, Math.round(ms / (24 * 60 * 60_000)));
  // Сначала близкий конец срока: он важнее застоя и виден раньше.
  if (at - now <= soonMs) {
    if (told === "soon") return { state: next, say: null };
    return { state: { ...next, told: "soon" }, say: { kind: "soon", days: days(at - now) } };
  }
  if (now - movedAt >= staleMs) {
    if (told === "stale") return { state: next, say: null };
    return { state: { ...next, told: "stale" }, say: { kind: "stale", days: days(now - movedAt) } };
  }
  return { state: next, say: null };
}

/** Сторож пяти минут сработал: подписки всё ещё нет — вот теперь это событие. */
export function realtimeDown(state, now, downMs = REALTIME_DOWN_MS) {
  const downSince = state?.downSince ?? null;
  if (downSince === null || state?.told || now - downSince < downMs) return { state: { ...state }, say: null };
  return { state: { downSince, told: true }, say: { kind: "down", since: downSince } };
}

// Коды, которые повторяются слово в слово из обхода в обход: беда стоит на месте, а письмо
// про неё владелец уже читал. Они и глушатся сутками. ⚠️ `missing` и `list` здесь ровно затем,
// чтобы боязливость (2026-09-16) не превратилась в два письма в день об одном и том же:
// удалённые пять видео `@orandocom.lis` дают одну и ту же строку каждый обход.
const REPEATING_CODES = new Set(["creator", "missing", "list"]);

/**
 * Убирает из письма обхода замечания, которые слово в слово уходили за последние сутки:
 * демо-креаторы не находятся каждый обход, удалённое видео не возвращается, и владелец эти
 * строки уже читал. Отдаёт новый список (с итоговой строкой вместо убранных на каждый код),
 * обновлённую память и число убранных.
 * ⚠️ Только коды из `REPEATING_CODES`: у остальных текст меняется от раза к разу и склеивать
 * нечего — там повтор сам по себе новость.
 * `fresh` — сколько замечаний осталось НОВЫХ (без итоговых строк). Ноль при непустом входе —
 * значит, обход не сказал ничего, чего владелец ещё не читал, и письма быть не должно.
 */
export function squashKnown(items, memory, now, ttl = SAME_ERROR_MS) {
  const next = {};
  // Заодно чистим память: запись старше суток ничего не глушит, а файл растить незачем.
  for (const [key, at] of Object.entries(memory ?? {})) {
    if (Number.isFinite(at) && now - at < ttl) next[key] = at;
  }
  const kept = [];
  const suppressedBy = new Map();   // код → сколько замечаний этого кода проглочено
  for (const item of items) {
    if (!REPEATING_CODES.has(item.code)) {
      kept.push(item);
      continue;
    }
    const key = `${item.code}|${item.text}`;
    if (next[key] !== undefined) {
      suppressedBy.set(item.code, (suppressedBy.get(item.code) ?? 0) + (item.count ?? 1));
      continue;
    }
    next[key] = now;
    kept.push(item);
  }
  for (const [code, count] of suppressedBy) {
    // Текст про креаторов остаётся прежним слово в слово: владелец читает эту строку с сентября.
    kept.push(code === "creator"
      ? { code, text: `${count} more creators with the same old errors (see earlier messages)` }
      : { code, text: `${count} more old notices, all the same (see earlier messages)` });
  }
  const suppressed = [...suppressedBy.values()].reduce((a, b) => a + b, 0);
  return { items: kept, memory: next, suppressed, fresh: kept.length - suppressedBy.size };
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
    logLine(`notice memory was not saved: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

// ------------------------------------------------------------------ прогрев
let warmUntil = 0;

/**
 * Прогрев: `WARMUP_MS` замечания о сети (`realtime`, `db`, `poll`) идут только в лог.
 * Зовётся при старте резидента и когда часы «прыгнули» — компьютер спал.
 */
export function startWarmup(reason = "start", ms = WARMUP_MS, now = Date.now()) {
  warmUntil = now + ms;
  logLine(`warmup after ${reason}: for ${Math.round(ms / 1000)} s network notices go to the log only`);
}

// ------------------------------------------------------------------ мягкие признаки сессии
// «Собрать удалось, но признаки истёкшей сессии видны» — это не письмо: одна строка в лог на
// обход и площадку. Копится здесь, потому что ставится в трёх файлах, а сводит её `sync.mjs`.
let hints = new Map();   // «площадка/профиль» → { count, text }

/** Мягкий признак истёкшей сессии. Письма не даёт никогда — только счётчик для строки в лог. */
export function sessionHint(where, text) {
  const key = String(where);
  const was = hints.get(key) ?? { count: 0, text: "" };
  hints.set(key, { count: was.count + 1, text: was.text || clean(text) });
}

/**
 * Срок cookie входа, замеченный на этом обходе, — в память и, если надо, в письмо.
 * Сторона с побочными действиями: чистое правило живёт в `sessionWatch`, здесь только файл
 * состояния и `notice`. `where` — площадка с профилем («instagram (profile-opera)»),
 * `expiresMs` — когда истекает cookie `sessionid` (`null` — её нет, тогда молчим: пустую
 * cookie ловят сами коллекторы и роняют креатора).
 */
export function noteSessionCookie(where, expiresMs, { now = Date.now(), log } = {}) {
  const key = String(where);
  const state = loadState();
  const sessions = state.sessions ?? {};
  const { state: next, say } = sessionWatch(sessions[key] ?? null, { expiresMs, now });
  saveState({ ...state, sessions: { ...sessions, [key]: next } });
  if (!say) return null;
  const text = say.kind === "soon"
    ? `${key}: the login cookie expires in ${say.days} d — log in to Opera again and take a fresh profile copy`
    : `${key}: the login has not been renewed for ${say.days} d — the platform seems to no longer treat us as logged in`;
  (log ?? logLine)(`  ⚠ session: ${text}`);
  notice("session", text);
  return say;
}

/**
 * Вернувшиеся видео — стереть из памяти пропавших, чтобы новая пропажа снова дала письмо.
 * Сторона с побочными действиями к `forgetReturned`. Файл пишется, только если кто-то вернулся:
 * обход идёт по каждому креатору, и переписывать память впустую незачем.
 * Письма о возвращении нет — только строка в лог (о нём владелец не просил).
 * Отдаёт число вернувшихся.
 */
export function noteReturned(handle, seenIds, { log } = {}) {
  const state = loadState();
  const { memory, returned } = forgetReturned(state.vanished ?? {}, seenIds);
  if (returned.length === 0) return 0;
  saveState({ ...state, vanished: memory });
  (log ?? logLine)(`  ${returned.length} videos we already reported as missing are back in the profile (${returned.join(", ")}) — if they vanish again, I will report again`);
  return returned.length;
}

/**
 * Сторона с побочными действиями к `shortOnce`: память `logs/notices-state.json` → `shortfall`.
 * Отдаёт, слать ли замечание. Файл пишется, только если память изменилась: зовётся на каждого
 * креатора, и переписывать её впустую незачем.
 */
export function noteShort(key, { short = false, healed = false, now = Date.now() } = {}) {
  const state = loadState();
  const was = state.shortfall ?? {};
  const { say, memory } = shortOnce(was, key, { short, healed, now });
  if (JSON.stringify(memory) !== JSON.stringify(was)) saveState({ ...state, shortfall: memory });
  return say;
}

/**
 * Пропавшие видео креатора — в лог каждый раз, в письмо только те, о ком ещё не писали.
 * Сторона с побочными действиями: правило живёт в `splitVanished`, здесь файл памяти и `notice`.
 * `gone` — `[{ id, publishedAt, url }]` новые сверху (так их отдаёт `vanishedVideos`).
 * Отдаёт `{ fresh, known }` — сколько ушло в письмо и сколько только в лог.
 */
export function noteVanished(handle, gone, { now = Date.now(), log } = {}) {
  const say = log ?? logLine;
  const list = gone ?? [];
  if (list.length === 0) return { fresh: 0, known: 0 };
  const state = loadState();
  const { fresh, known, memory } = splitVanished(list.map((v) => v.id), state.vanished ?? {}, now);
  saveState({ ...state, vanished: memory });

  const day = (v) => (v.publishedAt ? String(v.publishedAt).slice(0, 10) : "no date");
  // Лог — всегда и полностью, со ссылками: письмо короткое, а разбираться будут по логу.
  say(`  ${list.length} videos vanished from the profile (the list ended and they are not in it) — ${fresh.length} for the first time, ${known.length} already reported:`);
  const freshSet = new Set(fresh);
  for (const v of list) say(`    ${freshSet.has(v.id) ? "new " : "known"} ${day(v)} ${v.url ?? v.id}`);

  if (fresh.length > 0) {
    // В письме — даты: по ним видео узнаётся глазом, а ссылки съели бы весь предел строки.
    const dates = list.filter((v) => freshSet.has(v.id)).map((v) => {
      const d = day(v);
      return d.length === 10 ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : d;
    });
    // Дат больше десятка — хвост считается, а не режется посреди слова пределом строки.
    const shown = dates.length > 10 ? `${dates.slice(0, 10).join(", ")} and ${dates.length - 10} more` : dates.join(", ");
    notice("missing", `@${handle}: not found in the profile, looks deleted — ${fresh.length} videos from ${shown}; links are in the run log, I will not report these videos again`);
  }
  return { fresh: fresh.length, known: known.length };
}

/**
 * Забрать накопленные признаки и забыть их. Отдаёт `[{ where, count, text }]` —
 * по строке на площадку, в порядке появления.
 */
export function takeSessionHints() {
  const out = [...hints.entries()].map(([where, v]) => ({ where, count: v.count, text: v.text }));
  hints = new Map();
  return out;
}

// ------------------------------------------------------------------ замечания обхода
let run = null;   // список замечаний текущего обхода; null — обхода нет

/** Начало обхода: прежние замечания забыты, копим заново. */
export function startRun() {
  run = [];
  hints = new Map();
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
// Коды, при которых чего-то НЕ ХВАТАЕТ: данные не пришли, пришли не все или их некуда было
// записать. Каждый из них — письмо (владелец, 2026-09-16: «боязливая система — при любом
// странном поведении, когда чего-то не хватает, сразу пинговать и говорить, что не обновилось»).
export const LOST_CODES = new Set([
  "run",       // обход не начался или сорвался целиком
  "creator",   // креатор не собрался (обычно вместе с `failed`, но пусть код решает и сам)
  "missing",   // пришло меньше, чем лежит в базе: ноль публикаций или недобор видео
  "session",   // из-за входа что-то не собралось
  "list",      // площадка не отдала список
  "stop",      // стоп-экран или капча
  "limit",     // площадка ограничила запросы
  "comments",  // тексты комментариев не снялись
  "replies",   // ветки ответов не раскрылись
  "images",    // картинка не переложилась к нам
  "db",        // база не ответила посреди обхода — писали или читали вслепую
]);

// Коды, которые письма не дают: работа сделана, данные на месте, а строка — про то, КАК они
// дались. Список закрытый ровно затем, чтобы новый код по забывчивости попадал в письмо, а не
// терялся в логе: боязливой системе лучше лишний раз сказать, чем промолчать.
export const KEPT_CODES = new Set(["photo", "direct", "browser", "slow", "realtime", "poll", "retry"]);

/**
 * Потеряны ли данные обхода — только тогда владельцу нужно письмо.
 * Владелец, 2026-09-13: «сообщение в Telegram должно приходить, только если случилась проблема,
 * из-за которой не обновились данные; если обновление прошло штатно — отчёт не нужен».
 * Владелец, 2026-09-16 — то же правило, но пугливее: «чего-то не хватает» это тоже проблема,
 * даже когда обход дошёл до конца и ни один креатор не упал. Причина — разбор того же дня:
 * при мёртвой сессии Instagram шапка профиля читается, а лента нет, и обход выходил зелёным с
 * нулём публикаций. Потеря теперь = `failed > 0` ИЛИ любой код из `LOST_CODES`.
 * Чистая функция: её проверяют тесты.
 */
export function dataLost({ failed = 0, items = [] } = {}) {
  if (Number(failed) > 0) return true;
  // 🔴 Решает НЕ список потерь, а список молчунов: код, которого нет ни там ни там (новый,
  // забытый, написанный по месту), беспокоит владельца. `LOST_CODES` остаётся описанием того,
  // что мы считаем потерей сегодня, и его читают README и тесты.
  return (items ?? []).some((i) => i?.code !== undefined && i?.code !== null && !KEPT_CODES.has(String(i.code)));
}

export async function reportRun({ runId = null, trigger = "manual", depth = "all", depthFrom = null, depthTo = null, done = 0, failed = 0, slotLabel = null, log } = {}) {
  const all = run ?? [];
  run = null;
  if (all.length === 0 && !(Number(failed) > 0)) return false;
  if (!dataLost({ failed, items: all })) {
    // Замечания остаются в логе обхода: на сайте видно, что было, но телефон не беспокоим.
    const say = log ?? logLine;
    say(`notices (${all.length}) — log only: the data was fully updated, no message sent`);
    for (const i of all) say(`  [${i.code}] ${i.text}${i.count > 1 ? ` ×${i.count}` : ""}`);
    return false;
  }
  const now = Date.now();
  const state = loadState();
  const { items, memory, suppressed, fresh } = squashKnown(all, state.creatorErrors ?? {}, now);
  saveState({ ...state, creatorErrors: memory });
  // 🔴 Всё сказанное — прежнее: письма нет (владелец, 2026-09-16, после письма #135, в котором
  // была одна строка «ещё 1 прежних замечаний, всё те же»: «если понял, что замечания все те же,
  // не нужно, чтобы оно приходило»). Прежде решение «слать» принималось ДО отсева прежних, и от
  // письма оставалась одна итоговая строка. ⚠️ Упавший креатор без единого замечания письмо
  // по-прежнему даёт: сравнивать там не с чем, и молчание было бы потерей, а не повтором.
  if (all.length > 0 && fresh === 0) {
    const say = log ?? logLine;
    say(`notices (${all.length}) — all of them old and already reported: no message sent`);
    for (const i of all) say(`  [${i.code}] ${i.text}${i.count > 1 ? ` ×${i.count}` : ""}`);
    return false;
  }
  // `slotLabel` ставит только неудавшийся повтор: отдельного письма «не удался дважды» больше
  // нет (владелец получал два письма об одном событии), и эта строка — всё, что от него осталось.
  // Глубина словом — одной функцией на весь сборщик (`scope.mjs`): «всё», «неделя», «месяц»,
  // «период 01.09–09.09». Свой тернарник здесь стоил бы четвёртого места, где про «месяц» забыли.
  const head = `Amestat, run #${runId ?? "?"} (${trigger}, ${depthLabel(depth, depthFrom, depthTo)}): collected ${done}, failed ${failed}`
    + (slotLabel ? `\nsecond failure in a row after slot ${slotLabel}` : "");
  const text = buildMessage(head, items);
  const say = log ?? logLine;
  // Текст уходит и в лог обхода: сообщение в телефоне живёт своей жизнью, а `sync_runs.log`
  // на сайте должен показывать, о чём владельцу сказали и почему.
  say(`notices (${items.length}${suppressed > 0 ? `, ${suppressed} old ones not repeated within a day` : ""}) — message to the owner:\n${text}`);
  // В телефон — то же письмо по-русски (владелец, 2026-09-17). Отбор выше шёл по английскому
  // тексту и не меняется: переводится только то, что уже решено отправить.
  const ru = buildMessage(runHeadRu({ runId, trigger, depth, depthFrom, depthTo, done, failed, slotLabel }), itemsRu(items), MAX_CHARS, moreRu);
  // `sendTelegram` при неудаче пишет текст в лог сам. Русский туда не нужен: английский уже
  // записан строкой выше, а лог обхода — английский.
  const quiet = (line) => { if (line !== ru) say(line); };
  try {
    return await sendTelegram(ru, { log: quiet });
  } catch (e) {
    say(`notices were not sent: ${String(e?.message ?? e).split("\n")[0]}`);
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
// Резидент пишет владельцу только о том, что оставило данные без обновления: обход не смог
// начаться или сорвался (`run`). Связь с базой, Realtime, опрос, назначенный повтор, добитые
// браузеры — данные этим не теряются (просьба подхватится, повтор сам доберёт, сторож в базе
// напишет, если просьба не принята за три минуты), поэтому это только лог (владелец, 2026-09-13).
const RESIDENT_ALERT_CODES = new Set(["run"]);

export function residentNotice(code, text, now = Date.now()) {
  if (muted(code)) return;
  if (!RESIDENT_ALERT_CODES.has(String(code))) {
    logLine(`[${code}] ${clean(text)} — log only`);
    return;
  }
  if (isWarm(now, warmUntil) && WARM_CODES.has(String(code))) {
    logLine(`warmup: [${code}] ${clean(text)} — log only`);
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
  const text = buildMessage(`Amestat, resident: ${total} notices`, ready);
  logLine(`resident notices (${ready.length}) — message to the owner:\n${text}`);
  // В телефон — по-русски, в лог — английский текст выше (как и у письма обхода).
  const ru = buildMessage(residentHeadRu(total), itemsRu(ready), MAX_CHARS, moreRu);
  const quiet = (line) => { if (line !== ru) logLine(line); };
  // Ждать отправку некому: резидент живёт дальше, а неудача и так уйдёт строкой в лог.
  Promise.resolve(sendTelegram(ru, { log: quiet }))
    .catch((e) => logLine(`resident notices were not sent: ${String(e?.message ?? e).split("\n")[0]}`));
}

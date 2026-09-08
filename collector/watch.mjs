// Резидент: висит в фоне и сам решает, когда обходить.
//
// Четыре повода для обхода:
//   1. Догон при старте — компьютер спал или был выключен, слот прошёл без обхода (`catchup`).
//   2. Слот расписания — 10:00, 13:00, 17:00 по местному времени (`schedule`).
//   3. Кнопка «Обновить» на сайте — строка в `sync_requests` (`manual`). Слышим её через
//      Realtime, а раз в минуту ещё и спрашиваем базу сами: подписка умеет тихо отвалиться,
//      и тогда просьба владельца висела бы до перезапуска.
//   4. Повтор через час после неудачного обхода по расписанию (`retry`) — только по тем
//      креаторам, у кого осталась ошибка.
//
// Просьбы, пришедшие пока идёт обход, копятся и склеиваются: ключ — пара «охват × глубина»,
// а обход, который делает больше, забирает просьбы того, кто делает меньше (обход всех
// поглощает частные, глубина «всё» поглощает «неделю» того же охвата). Смысл один: не гонять
// браузер к одному креатору дважды подряд — TikTok от этого отвечает пустотой.
//
// Цепочка при неудаче: неудачный `schedule`/`catchup` → через час `retry` только по
// неудавшимся → если и он неудачен, одно сообщение владельцу в Telegram. Повтор ровно один:
// после него следующий шанс — следующий слот. Просьбы с сайта в эту цепочку не входят —
// их итог человек видит на сайте сам.
//
// Про свои беды резидент сообщает сам: отвалившийся Realtime, просьба, пойманная опросом
// вместо подписки, назначенный повтор и молчащая база уходят замечаниями (`notices.mjs`) —
// ОДНИМ письмом на все коды и не чаще раза в 5 минут. Замечания самого обхода к ним не
// примешиваются: их в конце обхода отправляет `sync.mjs` своим сообщением.
//
// ⚠️ Правила тишины (владелец, 2026-09-08 — семь сообщений за 12 минут после сна ноутбука):
//   • Realtime мигает CHANNEL_ERROR/TIMED_OUT → SUBSCRIBED по десять раз на дню, и это норма:
//     письмо уходит, только если подписки нет дольше пяти минут подряд, и один раз о возвращении.
//   • Одиночный `fetch failed` — не беда: пишем, когда опрос не выходит три раза подряд.
//   • Первые 90 секунд после старта и после сна (часы «прыгнули» — между тиками больше 3 минут)
//     замечания о сети только в лог: сеть после пробуждения встаёт не сразу.
//   • «Повтор назначен» — письмо только при свежей неудаче; восстановленный после перезапуска
//     повтор уходит строкой в лог: владелец это письмо уже получал.
//
// ⚠️ `seen_at` у просьбы ставится СРАЗУ, как только резидент её услышал, — до обхода и до
// очереди. Это ответ сторожу в базе (pg_cron, миграция v8): просьба, не принятая за 3 минуты,
// считается брошенной, и владельцу уходит Telegram «домашний сборщик не отвечает». Пока
// резидент жив, отметка появляется за секунды и сторож молчит. `taken_at` и `run_id` — другое
// дело: их ставит `sync.mjs`, когда обход реально начался.

import { createClient } from "@supabase/supabase-js";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, collectorDir } from "./env.mjs";
import { get, patch } from "./db.mjs";
import { runSync, busy } from "./sync.mjs";
import { missedSlot, nextSlot, retryDue } from "./schedule.mjs";
import { resolveBrowser, killLeftoverBrowsers } from "./browser.mjs";
import { sendTelegram } from "./telegram.mjs";
import {
  residentNotice, setNoticeLog, startWarmup,
  streak, sleepGap, realtimeStep, realtimeDown,
  DB_STREAK, REALTIME_DOWN_MS,
} from "./notices.mjs";

const TICK_MS = 60_000;   // как часто смотрим на часы
// Страховка на случай отвалившегося Realtime — раз в минуту, а не реже: сторож в базе ждёт
// отметки три минуты, и редкий опрос сам вызывал бы ложную тревогу у владельца.
const POLL_MS = 60_000;

const env = loadEnv();
const logsDir = resolve(collectorDir, "logs");
mkdirSync(logsDir, { recursive: true });

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
function today(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
function hhmm(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}
const depthWord = (depth) => (depth === "week" ? "неделя" : "всё");

function log(text) {
  const line = `${stamp()} ${text}`;
  console.log(line);
  try {
    appendFileSync(resolve(logsDir, `${today()}.log`), line + "\n", "utf8");
  } catch {
    // Не смогли записать в файл — консоль всё равно осталась, ронять резидент незачем.
  }
}
// Замечания резидента (`realtime`, `poll`, `retry`, беды базы) уходят своим сообщением и мимо
// обхода — значит и писать о них надо в тот же лог, с отметкой времени.
setNoticeLog(log);

// ------------------------------------------------------------------ база: считаем неудачи подряд
// Одиночный `fetch failed` владельцу не нужен: сеть моргнула — следующая минута всё поправит.
// Письмо уходит, когда дело не выходит три раза подряд (три минуты), и один раз о возвращении.
const dbStreaks = new Map();   // что именно не вышло → состояние счётчика

function dbResult(what, ok, text = "") {
  const { state, say } = streak(dbStreaks.get(what), ok, DB_STREAK);
  dbStreaks.set(what, state);
  if (say === "down") residentNotice("db", `${what} не выходит ${state.fails} раз подряд: ${text}`);
  else if (say === "up") residentNotice("db", `${what}: связь с базой вернулась`);
}

// ------------------------------------------------------------------ очередь просьб с сайта
const pending = new Map();   // id просьбы → строка
const handled = new Set();   // уже отданные в обход, чтобы опрос не подобрал их второй раз
let draining = false;
let lastRun = Promise.resolve();
let stopping = false;

/** Кладёт просьбу в очередь. Отдаёт её id, если это новая просьба, иначе null. */
function remember(row, source) {
  if (!row || row.taken_at) return null;
  const id = Number(row.id);
  if (!Number.isFinite(id) || handled.has(id) || pending.has(id)) return null;
  const depth = row.depth === "week" ? "week" : "all";
  pending.set(id, { id, creator_id: row.creator_id ?? null, requested_by: row.requested_by ?? null, depth });
  log(`просьба #${id} (${row.creator_id ? `креатор ${row.creator_id}` : "все"}, глубина ${depthWord(depth)}) — ${source}`);
  return id;
}

/**
 * «Принял» — отметка сторожу в базе, что резидент жив. Ставится до обхода и до очереди.
 * Фильтр `seen_at=is.null` — чтобы не перебить чужую (более раннюю) отметку.
 */
async function markSeen(ids) {
  if (ids.length === 0) return;
  try {
    await patch(`sync_requests?id=in.(${ids.join(",")})&seen_at=is.null`, { seen_at: new Date().toISOString() });
    log(`просьбы приняты: ${ids.map((i) => `#${i}`).join(", ")}`);
    dbResult("отметка просьб принятыми", true);
  } catch (e) {
    // Не пометилось — обход всё равно пойдёт, но сторож может успеть позвать владельца зря.
    const text = String(e?.message ?? e).split("\n")[0];
    log(`просьбы не помечены принятыми: ${text}`);
    dbResult("отметка просьб принятыми", false, text);
  }
}

/** Покрывает ли обход группы `big` просьбы группы `small`: охват шире или тот же, глубина не мельче. */
function covers(big, small) {
  const scopeOk = big.creatorId === null || big.creatorId === small.creatorId;
  const depthOk = big.depth === "all" || small.depth === "week";
  return scopeOk && depthOk;
}

/**
 * Просьбы одной пачки → обходы. Ключ — пара «охват × глубина»; дальше группы, которые
 * целиком покрыты другой группой, отдают ей свои id и своего обхода не получают.
 * ⚠️ «Все креаторы, неделя» НЕ покрывает «этот креатор, всё»: глубина мельче, и просьба
 * человека про полный список осталась бы невыполненной.
 */
function groupRequests(rows) {
  const groups = new Map();
  for (const r of rows) {
    const creatorId = r.creator_id ?? null;
    const depth = r.depth === "week" ? "week" : "all";
    const key = `${creatorId ?? "все"}|${depth}`;
    const g = groups.get(key) ?? { creatorId, depth, requestedBy: r.requested_by ?? null, ids: [] };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  // От самого широкого обхода к самому узкому: тогда покрывающий уже отобран, когда до
  // покрытого доходит очередь.
  const power = (g) => (g.creatorId === null ? 2 : 0) + (g.depth === "all" ? 1 : 0);
  const kept = [];
  for (const g of [...groups.values()].sort((a, b) => power(b) - power(a))) {
    const big = kept.find((k) => covers(k, g));
    if (big) big.ids.push(...g.ids);
    else kept.push(g);
  }
  return kept;
}

async function launch(opts) {
  const p = runSync({ ...opts, onLog: (line) => log(line) });
  lastRun = p.then(() => {}, () => {});
  const res = await p;
  log(`${res.ok ? "✓" : "✗"} обход #${res.runId ?? "?"}: собрано ${res.done}, с ошибкой ${res.failed}${res.error ? `, первая ошибка — ${res.error}` : ""}`);
  return res;
}

// ------------------------------------------------------------------ повтор через час
// Ожидающий повтор ровно один: новый слот, догон и просьба с сайта его не отменяют и второго
// не заводят. Отсчёт — от конца неудачного обхода, как в `retryDue`, чтобы перезапуск
// резидента (там повтор восстанавливается по базе) считал тот же момент.
let retryTimer = null;
let retryAt = null;

/**
 * Назначает повтор. `fresh` — обход только что не удался; письмо «повтор назначен» уходит
 * ТОЛЬКО в этом случае. Повтор, восстановленный по базе после перезапуска (в том числе
 * просроченный, который пойдёт сразу), — строка в лог: это письмо владелец уже получал в тот
 * раз, когда повтор назначался впервые, а результат обхода придёт своим письмом.
 */
function planRetry(due, slotLabel, { fresh = false } = {}) {
  if (retryTimer) {
    log(`повтор уже назначен на ${retryAt.toLocaleString()} — второй не завожу`);
    return;
  }
  retryAt = due;
  const delay = Math.max(0, due.getTime() - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = null;
    runRetry(slotLabel).catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`повтор сорвался: ${text}`);
      residentNotice("run", `повтор сорвался: ${text}`);
    });
  }, delay);
  log(`повтор ${fresh ? "назначен" : "восстановлен"} на ${due.toLocaleString()} (через ${Math.round(delay / 60_000)} мин), слот ${slotLabel}${fresh ? "" : " — письмо не шлю, оно уже уходило"}`);
  if (fresh) residentNotice("retry", `обход слота ${slotLabel} не удался — повтор назначен на ${due.toLocaleTimeString()}`);
}

/**
 * Сообщение владельцу о том, что повтор не смог даже начаться: база недоступна, обхода нет,
 * значит и письма от `reportRun` не будет — сказать больше некому.
 * ⚠️ Неудачный повтор сюда не попадает: у него есть своё письмо обхода со строкой
 * «вторая неудача подряд после слота HH:MM» (владелец, 2026-09-08: два письма об одном событии).
 */
async function callOwner({ slotLabel, retryLabel, error }) {
  const lines = [
    `Amestat: повтор обхода не смог начаться. Слот ${slotLabel}, повтор ${retryLabel}.`,
    `База не ответила: ${error}`,
    "Строки в sync_runs нет — на сайте этого тоже не видно.",
  ];
  const sent = await sendTelegram(lines.join("\n"), { log });
  if (sent) log("владельцу отправлено сообщение в Telegram");
}

async function runRetry(slotLabel) {
  if (stopping) return;
  const retryLabel = hhmm(new Date());

  // Ошибки могло уже не остаться: следующий слот, догон или просьба с сайта успели собрать всех.
  let failedCreators;
  try {
    failedCreators = await get("creators?select=id,handle&sync_error=not.is.null");
  } catch (e) {
    // База недоступна — повтор не смог даже начаться. Это как раз тот случай, когда
    // владельцу надо сказать: сам он этого не увидит, сайт тоже читает из базы.
    const text = String(e?.message ?? e).split("\n")[0];
    log(`повтор не начался: ${text}`);
    await callOwner({ slotLabel, retryLabel, error: text });
    return;
  }
  if (failedCreators.length === 0) {
    log("повтор пропущен: ни у кого не осталось ошибки");
    return;
  }

  log(`повтор по неудавшимся (${failedCreators.map((c) => `@${c.handle}`).join(", ")})`);
  // `slotLabel` уходит в обход: неудача повтора скажется строкой в его собственном письме,
  // а второго письма (прежний `callOwner`) больше нет.
  const res = await launch({ trigger: "retry", failedOnly: true, depth: "all", slotLabel });
  if (!res.ok) log(`вторая неудача подряд после слота ${slotLabel} — сказано письмом обхода #${res.runId ?? "?"}`);
}

/** Обход по расписанию или догон: неудача заводит повтор через час. */
async function runScheduled(trigger, slot) {
  const res = await launch({ trigger, depth: "all" });
  if (!res.ok && !stopping) planRetry(new Date(Date.now() + env.retryMs), hhmm(slot ?? new Date()), { fresh: true });
  return res;
}

async function drain() {
  if (draining || stopping) return;
  draining = true;
  try {
    while (pending.size > 0 && !stopping) {
      const rows = [...pending.values()];
      pending.clear();
      for (const r of rows) handled.add(r.id);
      for (const group of groupRequests(rows)) {
        await launch({
          trigger: "manual",
          creatorId: group.creatorId,
          depth: group.depth,
          requestedBy: group.requestedBy,
          requestIds: group.ids,
        });
        if (stopping) break;
      }
    }
  } finally {
    draining = false;
  }
}

// ------------------------------------------------------------------ старт
const browser = (() => {
  try {
    return resolveBrowser(env.browser).describe;
  } catch (e) {
    return `не выбран (${String(e?.message ?? e).split("\n")[0]})`;
  }
})();
// Прогрев: первые полторы минуты сеть только поднимается (особенно если компьютер спал), и
// её отказы владельцу не нужны — они уходят в лог и никуда больше.
startWarmup("старта");
log(`резидент запущен. Браузер: ${browser}. Пауза между креаторами ${Math.round(env.pauseMs / 1000)} с. Повтор после неудачи через ${Math.round(env.retryMs / 60_000)} мин. Instagram: ${env.igSource}. Логи: ${logsDir}`);

// 0. Остатки прошлых обходов: упавший обход оставляет окно Opera на нашем профиле, а оно и
//    память держит, и не даёт подняться следующему браузеру. Свои окна владельца не трогаем —
//    отбор идёт по нашему профилю в командной строке процесса.
try {
  const { killed, pids } = await killLeftoverBrowsers();
  if (killed > 0) {
    log(`добито окон Opera: ${killed} (${pids.join(", ")})`);
    residentNotice("browser", `при старте добито окон Opera на наших профилях: ${killed}`);
  }
} catch (e) {
  log(`остатки Opera не проверились: ${String(e?.message ?? e).split("\n")[0]}`);
}

// 1. Часы: каждую минуту смотрим, не наступил ли слот.
let nextAt = nextSlot(new Date());
log(`следующий слот: ${nextAt.toLocaleString()}`);
let lastTickAt = Date.now();
const tick = setInterval(() => {
  const now = new Date();
  // Часы «прыгнули» — компьютер спал, а не тикал. Сеть после пробуждения встаёт не сразу,
  // поэтому её ближайшие отказы идут только в лог (прогрев).
  const slept = sleepGap(lastTickAt, now.getTime());
  lastTickAt = now.getTime();
  if (slept > 0) {
    log(`прогрев после сна: ушло ${slept} мин`);
    startWarmup("сна");
  }
  if (now >= nextAt) {
    const slot = nextAt;
    nextAt = nextSlot(now);
    log(`слот ${slot.toLocaleTimeString()} — обход по расписанию. Следующий: ${nextAt.toLocaleString()}`);
    runScheduled("schedule", slot).catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`обход по расписанию сорвался: ${text}`);
      residentNotice("run", `обход по расписанию сорвался: ${text}`);
    });
  }
}, TICK_MS);

// 2. Realtime: вставки в sync_requests.
// Подписка у Supabase переподключается сама по десять раз на дню (в логе 2026-09-08: 13:31,
// 15:31, 15:49, 16:12, 17:33…), и мигание CHANNEL_ERROR/TIMED_OUT → SUBSCRIBED внутри пяти
// минут событием не считается вовсе. Сторож заводится на пять минут и снимается возвращением
// подписки; сработал — значит просьбы всё это время ловит только опрос, и вот об этом письмо.
let realtime = { downSince: null, told: false };
let realtimeTimer = null;

function realtimeStatus(ok) {
  const step = realtimeStep(realtime, ok, Date.now());
  realtime = step.state;
  if (ok) {
    if (realtimeTimer) {
      clearTimeout(realtimeTimer);
      realtimeTimer = null;
    }
    if (step.say?.kind === "up") {
      residentNotice("realtime", `Realtime вернулся, перерыв ${step.say.minutes} мин — просьбы снова ловлю подпиской`);
    }
    return;
  }
  // ⚠️ Сторож заводится один раз на перерыв: CHANNEL_ERROR сыплется пачками, и перезавод
  // таймера на каждом отодвигал бы пять минут бесконечно.
  if (realtimeTimer || realtime.told) return;
  realtimeTimer = setTimeout(() => {
    realtimeTimer = null;
    const late = realtimeDown(realtime, Date.now());
    realtime = late.state;
    if (late.say) {
      residentNotice("realtime", `Realtime не работает с ${hhmm(new Date(late.say.since))}, просьбы ловлю опросом раз в минуту`);
    }
  }, REALTIME_DOWN_MS);
  realtimeTimer.unref?.();
}

const supabase = createClient(env.supabaseUrl, env.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 5 } },
});
const channel = supabase
  .channel("amestat-collector-sync-requests")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "sync_requests" }, (payload) => {
    const fresh = remember(payload.new, "Realtime");
    (async () => {
      // Сначала отметка «принял», потом очередь: обход может быть занят надолго, а сторожу
      // в базе на ответ отпущено три минуты.
      if (fresh !== null) await markSeen([fresh]);
      await drain();
    })().catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`очередь просьб сорвалась: ${text}`);
      residentNotice("run", `очередь просьб сорвалась: ${text}`);
    });
  })
  .subscribe((status) => {
    // Лог видит каждое мигание — по нему и разбирают, как часто оно случается. Владелец
    // узнаёт только о затяжном перерыве и о возвращении после него.
    log(`Realtime: ${status}`);
    realtimeStatus(status === "SUBSCRIBED");
  });

// 3. Страховка: раз в минуту спрашиваем невзятые просьбы сами. Берём все, у кого пусто
//    `taken_at`, а не только непринятые: резидент, убитый между «принял» и «взял», после
//    перезапуска иначе никогда бы не вернулся к просьбе с `seen_at` (сторож в базе её тоже
//    не тронет — он ждёт только непринятых). Те, что уже в памяти, `remember()` отсекает.
//    При старте этот же опрос забирает всё, что накопилось, пока компьютер спал.
let firstPoll = true;
async function poll() {
  try {
    const rows = await get("sync_requests?select=id,creator_id,requested_by,depth,seen_at,taken_at&taken_at=is.null&order=id.asc");
    const fresh = [];
    for (const row of rows) {
      const id = remember(row, "опрос");
      if (id === null) continue;
      fresh.push(id);
      // Просьбу должен приносить Realtime за секунды; опрос — страховка, и его находка значит
      // лаг до минуты. Первый опрос при старте — не лаг: он подбирает всё, что накопилось,
      // пока компьютер спал.
      residentNotice("poll", `просьба #${id} поймана опросом, а не Realtime${firstPoll ? " (первый опрос при старте)" : ""}`);
    }
    dbResult("опрос просьб", true);
    await markSeen(fresh);
    if (pending.size > 0) await drain();
  } catch (e) {
    const text = String(e?.message ?? e).split("\n")[0];
    log(`опрос просьб не вышел: ${text}`);
    dbResult("опрос просьб", false, text);
  } finally {
    firstPoll = false;
  }
}
await poll();
const polling = setInterval(() => { poll().catch(() => {}); }, POLL_MS);


// ------------------------------------------------------------------ аккуратное завершение
let bye = false;
async function stop(signal) {
  if (bye) {
    log("второй сигнал — выхожу немедленно");
    process.exit(1);
  }
  bye = true;
  stopping = true;
  log(`${signal}: останавливаюсь${busy() ? ", жду конца текущего обхода" : ""}`);
  clearInterval(tick);
  clearInterval(polling);
  if (retryTimer) {
    // Повтор не теряется: при следующем старте он восстановится по `sync_runs` через retryDue.
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (realtimeTimer) {
    clearTimeout(realtimeTimer);
    realtimeTimer = null;
  }
  try {
    await channel.unsubscribe();
    await supabase.removeAllChannels();
  } catch {
    // Подписка могла уже отвалиться — на выход это не влияет.
  }
  await lastRun;
  log("остановлен");
  process.exit(0);
}
process.on("SIGINT", () => { stop("Ctrl+C").catch(() => process.exit(1)); });
process.on("SIGTERM", () => { stop("SIGTERM").catch(() => process.exit(1)); });

// 4. Несделанный повтор: резидент мог быть убит между неудачей и повтором (перезагрузка,
//    выход из системы). Таймер живёт в памяти, а память ушла — поэтому спрашиваем базу.
try {
  const [scheduled] = await get("sync_runs?select=started_at,finished_at,ok&trigger=in.(schedule,catchup)&order=started_at.desc&limit=1");
  const [lastRetry] = await get("sync_runs?select=started_at&trigger=eq.retry&order=started_at.desc&limit=1");
  const due = retryDue(new Date(), scheduled ?? null, lastRetry ?? null, env.retryMs);
  // `fresh: false` — восстановленный повтор владельцу не письмо: он его уже получал тогда,
  // когда повтор назначался впервые. Просрочен и пойдёт сразу — тем более: придёт письмо обхода.
  if (due && !stopping) planRetry(due, hhmm(new Date(scheduled.started_at)), { fresh: false });
  else log("несделанных повторов нет");
} catch (e) {
  const text = String(e?.message ?? e).split("\n")[0];
  log(`повтор не восстановлен: ${text}`);
  residentNotice("db", `повтор не восстановлен: ${text}`);
}

// 5. Догон пропущенного слота — последним делом: он может занять минуты, а часы, Realtime,
//    опрос и обработчик Ctrl+C к этому времени уже работают. Иначе просьба с сайта ждала бы
//    конца догона незамеченной, а Ctrl+C не был бы услышан вовсе.
try {
  const runs = await get("sync_runs?select=started_at&order=started_at.desc&limit=1");
  const last = runs[0]?.started_at ? new Date(runs[0].started_at) : null;
  const missed = missedSlot(new Date(), last);
  log(`последний обход: ${last ? last.toLocaleString() : "не было ни одного"}; пропущенный слот: ${missed ? missed.toLocaleTimeString() : "нет"}`);
  if (missed && !stopping) await runScheduled("catchup", missed);
} catch (e) {
  const text = String(e?.message ?? e).split("\n")[0];
  log(`догон не вышел: ${text}`);
  residentNotice("db", `догон пропущенного слота не вышел: ${text}`);
}

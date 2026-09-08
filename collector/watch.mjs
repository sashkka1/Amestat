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
import { resolveBrowser } from "./browser.mjs";
import { sendTelegram } from "./telegram.mjs";

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
  } catch (e) {
    // Не пометилось — обход всё равно пойдёт, но сторож может успеть позвать владельца зря.
    log(`просьбы не помечены принятыми: ${String(e?.message ?? e).split("\n")[0]}`);
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

function planRetry(due, slotLabel) {
  if (retryTimer) {
    log(`повтор уже назначен на ${retryAt.toLocaleString()} — второй не завожу`);
    return;
  }
  retryAt = due;
  const delay = Math.max(0, due.getTime() - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = null;
    runRetry(slotLabel).catch((e) => log(`повтор сорвался: ${String(e?.message ?? e).split("\n")[0]}`));
  }, delay);
  log(`повтор назначен на ${due.toLocaleString()} (через ${Math.round(delay / 60_000)} мин), слот ${slotLabel}`);
}

/** Одно сообщение владельцу: обход не удался дважды. */
async function callOwner({ slotLabel, retryLabel, failures, error, runId }) {
  const lines = [
    `Amestat: обход по расписанию не удался дважды. Слот ${slotLabel}, повтор ${retryLabel}.`,
  ];
  if (failures?.length) {
    lines.push("Не собрались:");
    for (const f of failures) lines.push(`@${f.handle} — ${f.error}`);
  } else if (error) {
    lines.push(`Обход не дошёл до креаторов: ${error}`);
  }
  lines.push(runId ? `Подробности в sync_runs #${runId}.` : "Строки в sync_runs нет — база была недоступна.");
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
    await callOwner({ slotLabel, retryLabel, failures: [], error: text, runId: null });
    return;
  }
  if (failedCreators.length === 0) {
    log("повтор пропущен: ни у кого не осталось ошибки");
    return;
  }

  log(`повтор по неудавшимся (${failedCreators.map((c) => `@${c.handle}`).join(", ")})`);
  const res = await launch({ trigger: "retry", failedOnly: true, depth: "all" });
  if (res.ok) return;
  await callOwner({ slotLabel, retryLabel, failures: res.failures, error: res.error, runId: res.runId });
}

/** Обход по расписанию или догон: неудача заводит повтор через час. */
async function runScheduled(trigger, slot) {
  const res = await launch({ trigger, depth: "all" });
  if (!res.ok && !stopping) planRetry(new Date(Date.now() + env.retryMs), hhmm(slot ?? new Date()));
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
log(`резидент запущен. Браузер: ${browser}. Пауза между креаторами ${Math.round(env.pauseMs / 1000)} с. Повтор после неудачи через ${Math.round(env.retryMs / 60_000)} мин. Instagram: ${env.igSource}. Логи: ${logsDir}`);

// 1. Часы: каждую минуту смотрим, не наступил ли слот.
let nextAt = nextSlot(new Date());
log(`следующий слот: ${nextAt.toLocaleString()}`);
const tick = setInterval(() => {
  const now = new Date();
  if (now >= nextAt) {
    const slot = nextAt;
    nextAt = nextSlot(now);
    log(`слот ${slot.toLocaleTimeString()} — обход по расписанию. Следующий: ${nextAt.toLocaleString()}`);
    runScheduled("schedule", slot).catch((e) => log(`обход по расписанию сорвался: ${String(e?.message ?? e).split("\n")[0]}`));
  }
}, TICK_MS);

// 2. Realtime: вставки в sync_requests.
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
    })().catch((e) => log(`очередь просьб сорвалась: ${String(e?.message ?? e).split("\n")[0]}`));
  })
  .subscribe((status) => log(`Realtime: ${status}`));

// 3. Страховка: раз в минуту спрашиваем невзятые просьбы сами. Берём все, у кого пусто
//    `taken_at`, а не только непринятые: резидент, убитый между «принял» и «взял», после
//    перезапуска иначе никогда бы не вернулся к просьбе с `seen_at` (сторож в базе её тоже
//    не тронет — он ждёт только непринятых). Те, что уже в памяти, `remember()` отсекает.
//    При старте этот же опрос забирает всё, что накопилось, пока компьютер спал.
async function poll() {
  try {
    const rows = await get("sync_requests?select=id,creator_id,requested_by,depth,seen_at,taken_at&taken_at=is.null&order=id.asc");
    const fresh = [];
    for (const row of rows) {
      const id = remember(row, "опрос");
      if (id !== null) fresh.push(id);
    }
    await markSeen(fresh);
    if (pending.size > 0) await drain();
  } catch (e) {
    log(`опрос просьб не вышел: ${String(e?.message ?? e).split("\n")[0]}`);
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
  if (due && !stopping) planRetry(due, hhmm(new Date(scheduled.started_at)));
  else log("несделанных повторов нет");
} catch (e) {
  log(`повтор не восстановлен: ${String(e?.message ?? e).split("\n")[0]}`);
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
  log(`догон не вышел: ${String(e?.message ?? e).split("\n")[0]}`);
}

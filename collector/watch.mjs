// Резидент: висит в фоне и сам решает, когда обходить.
//
// Четыре повода для обхода:
//   1. Первый обход дня от старта компьютера (`catchup`) — резидент поднялся, дал машине
//      `AMESTAT_START_DELAY_MIN` минут на разогрев (пусто — 5) и пошёл (владелец, 2026-09-10:
//      «компьютер включился, ~5 минут на разогрев — и обход»). Тем же правилом обход
//      планируется после сна: машина могла проснуться утром нового дня. Прежний догон
//      ПРОПУЩЕННОГО слота этим и заменён — он ждал уже прошедшего часа расписания.
//   2. Слот расписания — 16:00 по варшавскому времени (`schedule`; часы задаются `AMESTAT_SLOTS`,
//      глубина — `AMESTAT_SLOT_DEPTH`, по умолчанию «всё»: владелец, 2026-09-09 — «в ежедневном
//      обновлении пусть всё обновляется»).
//      ⚠️ Слот пропускается, только если обход по всем был НЕДАВНО — за последние
//      `AMESTAT_SLOT_FRESH_HOURS` часов (пусто — 3). Владелец, 2026-09-10: «обновил утром или
//      в час дня — вечерний слот пусть отработает; обновил в три-четыре — уже не нужно».
//      У первого обхода дня правило другое и грубее: «сегодня уже обходили всех» — он и должен
//      быть один на сутки, сколько бы раз компьютер ни включали.
//   3. Кнопка «Обновить» на сайте — строка в `sync_requests` (`manual`). Слышим её через
//      Realtime, а раз в минуту ещё и спрашиваем базу сами: подписка умеет тихо отвалиться,
//      и тогда просьба владельца висела бы до перезапуска.
//   4. Повтор через час после неудачного обхода по расписанию (`retry`) — только по тем
//      креаторам, у кого осталась ошибка.
//   5. Закрытие окна расчёта выплат (`window`, миграция v38, владелец 2026-09-19: «сделай так,
//      чтобы в момент, когда окно закрывается, конкретно это видео обновлялось»). Раз в пять
//      минут спрашиваем базу, у кого прошла отметка «публикация + окно» и снимка после неё ещё
//      нет, — и обходим этих креаторов коротким заходом, без комментариев. Иначе снимок
//      приходил бы следующим обходом, через 2–18 часов после отметки, и лишние часы просмотров
//      попадали бы в выплату.
//
// Просьбы, пришедшие пока идёт обход, копятся и склеиваются: ключ — «охват × глубина (с краями
// периода)», а обход, который делает больше, забирает просьбы того, кто делает меньше (обход
// всех поглощает частные, «всё» поглощает «месяц» и «неделю», «месяц» — «неделю»). Смысл один:
// не гонять браузер к одному креатору дважды подряд — TikTok от этого отвечает пустотой.
// ⚠️ Глубина «период» (v18) не поглощает и не поглощается ничем, кроме такого же периода: у неё
// своя ВЕРХНЯЯ граница, и чужие свежие видео она отсекает.
// ⚠️ Галочки «снимать комментарии» и «снимать ветки» ключом группы НЕ являются: они
// складываются по «или» — `true` поглощает `false` того же охвата и глубины. Иначе просьба
// «всё, с комментариями» и просьба «всё, без комментариев» дали бы два обхода подряд, а
// человек, попросивший комментарии, всё равно должен их получить.
// ⚠️ Так же складывается охват видео (`videos`, миграция v17): хоть одна просьба «всё» — обход
// идёт по всему списку. Расписание, догон и повтор после слота ходят с «всё» всегда; охват
// «только наши» наследует лишь повтор ручной просьбы — у той, которую он повторяет.
// ⚠️ Тем же путём ходит потолок числа видео (`max_videos`, миграция v19): в склейке побеждает
// тот, что делает больше (`null` — «без потолка» — сильнее любого числа), расписание, догон и
// повтор после слота ходят без потолка всегда, а повтор ручной просьбы берёт её потолок — иначе
// второй заход молча стоил бы тех минут, ради которых потолок и просили.
//
// Цепочка при неудаче: неудачный `schedule`/`catchup` → через час `retry` только по
// неудавшимся → если и он неудачен, одно сообщение владельцу в Telegram. Повтор ровно один:
// после него следующий шанс — следующий слот.
//
// ⚠️ Своя, короткая цепочка есть и у РУЧНОЙ просьбы (владелец, 2026-09-09): если обход
// `manual` свалила защита TikTok по адресу, резидент сам назначает один повтор через
// `AMESTAT_MANUAL_RETRY_MIN` минут (пусто — 25) — `trigger retry`, только по неудавшимся,
// без письма при назначении. Повтор отменяется, если к сроку по тем креаторам уже прошёл
// удачный обход. Всё остальное про просьбы с сайта по-прежнему человек видит сам.
//
// 🔴 Telegram — только когда данные НЕ обновились (владелец, 2026-09-13: «сообщение должно
// приходить, только если случилась проблема, из-за которой не обновились данные; если всё
// прошло штатно — отчёт не нужен»). Обход пишет владельцу, лишь если хоть один креатор не
// собрался или обход не начался (`dataLost` в `notices.mjs`); резидент — лишь если обход не смог
// начаться или сорвался (код `run`). Отвалившийся Realtime, молчащая база, назначенный повтор,
// медленный креатор, откат прямого запроса — всё это уходит только в лог: данные этим не
// теряются (повтор сам доберёт, а просьбу, не принятую за три минуты, подхватит сторож в базе).
// Прежние правила тишины (прогрев 90 с после старта и сна, серии `fetch failed`) остались —
// они теперь решают, что писать в лог, а не в телефон.
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
import {
  nextSlot, retryDue, firstRunAt,
  slotAlreadyCovered, coveredRecently, addressProtectionHandles, manualRetryAt, retryStillNeeded,
} from "./schedule.mjs";
import { logSystem } from "./synclog.mjs";
import { groupRequests } from "./requests.mjs";
import { dueRuns, windowDue, MAX_AGE_HOURS } from "./window.mjs";
import { depthLabel, normalizeDepth, videoCap } from "./scope.mjs";
import { resolveBrowser, killLeftoverBrowsers } from "./browser.mjs";
import { sendTelegram, flushNight } from "./telegram.mjs";
import { retryFailedRu } from "./telegram-ru.mjs";
import {
  residentNotice, setNoticeLog, startWarmup,
  streak, sleepGap, realtimeStep, realtimeDown,
  DB_STREAK, REALTIME_DOWN_MS,
} from "./notices.mjs";

const TICK_MS = 60_000;   // как часто смотрим на часы
// Страховка на случай отвалившегося Realtime — раз в минуту, а не реже: сторож в базе ждёт
// отметки три минуты, и редкий опрос сам вызывал бы ложную тревогу у владельца.
const POLL_MS = 60_000;
// Как часто смотрим, не закрылось ли у кого окно расчёта. Пять минут — компромисс: точнее
// незачем (обход сам занимает минуты), реже — теряется смысл затеи.
const WINDOW_MS = 5 * 60_000;

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
/** Первая строка текста ошибки: в лог резидента стек не нужен. */
function short(e) {
  const text = String(e?.message ?? e);
  const cut = text.indexOf("\n");
  return cut === -1 ? text : text.slice(0, cut);
}

function hhmm(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}
/**
 * Момент СЛОТА словами. Слоты живут в своей зоне (`AMESTAT_SLOT_TZ`), и печатать их по часам
 * машины значило бы врать: если машина не в той зоне, слот «7:00» вышел бы в лог восьмым часом.
 * Зоны нет — печатаем как раньше, по машине. `withDate` добавляет дату (для «следующий слот»).
 */
function slotHhmm(date, withDate = false) {
  if (!env.slotTz) return withDate ? date.toLocaleString() : hhmm(date);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: env.slotTz, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    ...(withDate ? { day: "2-digit", month: "2-digit", year: "numeric" } : {}),
  }).format(date);
}
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
  if (say === "down") residentNotice("db", `${what} failing ${state.fails} times in a row: ${text}`);
  else if (say === "up") residentNotice("db", `${what}: the database connection is back`);
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
  // Глубина и края периода (миграция v18). Незнакомое слово и «период» без границ опускаются
  // до «всё» — со строкой в лог: молча подменённая глубина хуже, чем громко подменённая.
  const { depth, from: depthFrom, to: depthTo, note } = normalizeDepth(row.depth, row.depth_from ?? null, row.depth_to ?? null);
  if (note) log(`request #${id}: ${note}`);
  // Колонки в базе `not null default true`, но старую просьбу (или обрезанный select) читаем
  // мягко: нет поля — считаем, что снимать надо, как раньше и было.
  const comments = row.comments !== false;
  const replies = row.replies !== false;
  // А этот — `default false`: нет поля — значит, только наши видео, как всегда.
  const allVideos = row.all_videos === true;
  // Охват списка (v17): `default 'all'` в базе; нет поля вовсе (старая просьба) — тоже «всё».
  const videos = row.videos === "ours" ? "ours" : "all";
  // Потолок числа видео (v19): целое или null («без потолка»). Нет поля, ноль, мусор — null,
  // то есть как было до v19.
  const maxVideos = videoCap(row.max_videos);
  pending.set(id, { id, creator_id: row.creator_id ?? null, requested_by: row.requested_by ?? null, depth, depth_from: depthFrom, depth_to: depthTo, videos, max_videos: maxVideos, comments, replies, allVideos });
  log(`request #${id} (${row.creator_id ? `creator ${row.creator_id}` : "all"}, depth ${depthLabel(depth, depthFrom, depthTo)}, comments ${comments ? "yes" : "no"}, replies ${replies ? "yes" : "no"}${allVideos ? ", including videos that are not ours" : ""}${videos === "ours" ? " · ours only" : ""}${maxVideos !== null ? ` · up to ${maxVideos} videos` : ""}) — ${source}`);
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
    log(`requests acknowledged: ${ids.map((i) => `#${i}`).join(", ")}`);
    dbResult("marking requests as seen", true);
  } catch (e) {
    // Не пометилось — обход всё равно пойдёт, но сторож может успеть позвать владельца зря.
    const text = String(e?.message ?? e).split("\n")[0];
    log(`requests were not marked as seen: ${text}`);
    dbResult("marking requests as seen", false, text);
  }
}

async function launch(opts) {
  const p = runSync({ ...opts, onLog: (line) => log(line) });
  lastRun = p.then(() => {}, () => {});
  const res = await p;
  log(`${res.ok ? "✓" : "✗"} run #${res.runId ?? "?"}: collected ${res.done}, failed ${res.failed}${res.error ? `, first error — ${res.error}` : ""}`);
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
function planRetry(due, slotLabel, { fresh = false, kind = "schedule", handles = [], videos = "all", maxVideos = null } = {}) {
  if (retryTimer) {
    log(`a retry is already scheduled for ${retryAt.toLocaleString()} — not scheduling a second one`);
    return;
  }
  retryAt = due;
  const delay = Math.max(0, due.getTime() - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = null;
    runRetry(slotLabel, { handles, videos, maxVideos }).catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`the retry crashed: ${text}`);
      residentNotice("run", `the retry crashed: ${text}`);
    });
  }, delay);
  if (kind === "manual") {
    // Повтор ручной просьбы: письма при назначении нет вовсе — человек стоит у сайта и
    // видит там и неудачу, и следующий обход. В журнал сайта строка всё же уходит.
    const text = `retry of the manual request scheduled for ${hhmm(due)} (in ${Math.round(delay / 60_000)} min): TikTok address throttling for ${handles.map((h) => `@${h}`).join(", ")}`;
    log(text);
    void logSystem(text, { level: "warn" });
    return;
  }
  log(`retry ${fresh ? "scheduled" : "restored"} for ${due.toLocaleString()} (in ${Math.round(delay / 60_000)} min), slot ${slotLabel}${fresh ? "" : " — no message sent, it already went out"}`);
  if (fresh) residentNotice("retry", `the run for slot ${slotLabel} failed — a retry is scheduled for ${due.toLocaleTimeString()}`);
}

/**
 * Сообщение владельцу о том, что повтор не смог даже начаться: база недоступна, обхода нет,
 * значит и письма от `reportRun` не будет — сказать больше некому.
 * ⚠️ Неудачный повтор сюда не попадает: у него есть своё письмо обхода со строкой
 * «вторая неудача подряд после слота HH:MM» (владелец, 2026-09-08: два письма об одном событии).
 */
async function callOwner({ slotLabel, retryLabel, error }) {
  const lines = [
    `Amestat: the retry run could not even start. Slot ${slotLabel}, retry ${retryLabel}.`,
    `The database did not respond: ${error}`,
    "There is no row in sync_runs — the site does not show this either.",
  ];
  // В телефон — по-русски (владелец, 2026-09-17). Не ушло — `sendTelegram` пишет текст в лог,
  // и там он остаётся английским, как был.
  const en = lines.join("\n");
  const ru = retryFailedRu({ slotLabel, retryLabel, error });
  const sent = await sendTelegram(ru, { log: (line) => log(line === ru ? en : line) });
  if (sent) log("a Telegram message was sent to the owner");
}

async function runRetry(slotLabel, { handles = [], videos = "all", maxVideos = null } = {}) {
  if (stopping) return;
  const retryLabel = hhmm(new Date());

  // Ошибки могло уже не остаться: следующий слот, догон или просьба с сайта успели собрать всех.
  let failedCreators;
  try {
    // Архивных и тех, у кого стоит «не обновлять», повтор не поднимает (миграция v32):
    // иначе он каждый час бился бы о креатора, которого сам же владелец и отключил.
    failedCreators = await get("creators?select=id,handle,sync_error&sync_error=not.is.null&archived_at=is.null&sync_off=is.false");
  } catch (e) {
    // База недоступна — повтор не смог даже начаться. Это как раз тот случай, когда
    // владельцу надо сказать: сам он этого не увидит, сайт тоже читает из базы.
    const text = String(e?.message ?? e).split("\n")[0];
    log(`the retry did not start: ${text}`);
    await callOwner({ slotLabel, retryLabel, error: text });
    return;
  }
  if (failedCreators.length === 0) {
    log("retry skipped: nobody is left with an error");
    return;
  }
  // Повтор ручной просьбы назван поимённо: к сроку по ТЕМ креаторам мог пройти удачный обход,
  // и тогда будить браузер незачем — чужие ошибки этот повтор не чинит.
  if (handles.length > 0 && !retryStillNeeded(failedCreators, handles)) {
    const text = `retry of the manual request cancelled: a successful run has already covered ${handles.map((h) => `@${h}`).join(", ")}`;
    log(text);
    void logSystem(text, { level: "info" });
    return;
  }

  log(`retry over the failed ones (${failedCreators.map((c) => `@${c.handle}`).join(", ")})`);
  // `slotLabel` уходит в обход: неудача повтора скажется строкой в его собственном письме,
  // а второго письма (прежний `callOwner`) больше нет.
  // Расписание, догон и повтор всегда снимают всё: комментарии и ветки. Галочки бывают только
  // у просьбы с сайта — там их ставит человек.
  // ⚠️ Охват и потолок — исключение: повтор ПОСЛЕ РУЧНОЙ просьбы наследует её охват («только
  // наши») и её потолок («до N видео»), а повтор после слота идёт с полным охватом и без
  // потолка, как и сам слот.
  const res = await launch({ trigger: "retry", failedOnly: true, depth: env.slotDepth, videos, maxVideos, comments: true, replies: true, slotLabel });
  if (!res.ok) log(`second failure in a row after slot ${slotLabel} — reported by the message of run #${res.runId ?? "?"}`);
}

/**
 * Был ли сегодня, до сих пор, завершённый обход по ВСЕМ креаторам. Отдаёт момент его конца
 * или null. База не ответила — считаем, что не было: пропустить слот из-за молчания базы
 * значит потерять сегодняшний срез, а лишний обход всего лишь стоит времени.
 */
async function coveredToday(now = new Date(), { fresh = false } = {}) {
  try {
    const runs = await get("sync_runs?select=scope,finished_at&scope=eq.all&finished_at=not.is.null&order=finished_at.desc&limit=10");
    // Слоту важна свежесть (обход за последние `AMESTAT_SLOT_FRESH_HOURS` часов), первому
    // обходу дня — сам факт «сегодня уже обходили».
    return fresh ? coveredRecently(now, runs, env.slotFreshMs) : slotAlreadyCovered(now, runs, env.slotTz);
  } catch (e) {
    const text = String(e?.message ?? e).split("\n")[0];
    log(`could not check whether there was a full run today: ${text}`);
    dbResult("checking today's run", false, text);
    return null;
  }
}

/**
 * Обход по расписанию или догон: неудача заводит повтор через час.
 * ⚠️ Сначала проверка «сегодня уже обошли всех» — слот пропускается вовсе (владелец, 2026-09-09).
 */
async function runScheduled(trigger, slot) {
  // Слот и «сегодня» считаются в зоне слотов — значит и печатаются в ней, иначе строка про
  // пропуск мешала бы два разных времени в одном предложении.
  const label = slotHhmm(slot ?? new Date());
  // 🔴 Правило «сегодня уже обходили всех» действует ТОЛЬКО на первый обход дня (старт
  // компьютера, пробуждение, догон). Слот по расписанию идёт всегда: обновлений в сутки
  // ровно два — утреннее от старта и вечернее по часам, и второе гасить нечем (владелец,
  // 2026-09-10: «почему автообновление в 5 часов не отработало»). До этой правки утренний
  // обход закрывал собой вечерний слот, и данные за день оставались утренними.
  // ⚠️ Время прошлого обхода печатается по местным часам, а слот — в своей зоне: иначе в
  // одном предложении стояли бы два разных времени про один момент.
  const fresh = trigger !== "catchup";
  const covered = await coveredToday(new Date(), { fresh });
  if (covered) {
    const what = fresh ? `slot ${label}` : "the first update of the day";
    const why = fresh
      ? `a full run happened recently, at ${hhmm(covered)}`
      : `there already was a full run today at ${hhmm(covered)}`;
    const text = `${what} skipped: ${why}`;
    log(text);
    void logSystem(text, { level: "info" });
    return { ok: true, skipped: true, done: 0, failed: 0, runId: null };
  }
  const res = await launch({ trigger, depth: env.slotDepth, comments: true, replies: true });
  // Первый обход дня не слот: его время — местное, а не час расписания в зоне слотов
  // (в логе 13.09 стояло «слот 06:08» про обход, начатый в 07:08 по Минску).
  const retryLabel = trigger === "catchup" ? hhmm(new Date()) : label;
  if (!res.ok && !stopping) planRetry(new Date(Date.now() + env.retryMs), retryLabel, { fresh: true });
  return res;
}

// ------------------------------------------------------------------ первый обход дня
// Владелец, 2026-09-10: «первый обход дня должен запускаться от старта компьютера: компьютер
// включился, ~5 минут на разогрев — и обход». Этим заменён прежний догон пропущенного слота
// (`missedSlot`): он ждал ПРОШЕДШЕГО слота, и включённый утром компьютер при слоте 16:00 сидел
// бы без единого среза до вечера. Пауза — `AMESTAT_START_DELAY_MIN` (пусто — 5 мин): сеть после
// включения встаёт не сразу.
// ⚠️ Проверки «сегодня уже обходили всех» здесь намеренно НЕТ: она внутри `runScheduled`
// (`coveredToday`), и если обход сегодня уже был, в лог уйдёт прежняя строка про пропуск.
// ⚠️ Таймер один на резидента: старт заводит его, пробуждение из сна — только если он не висит.
let firstRunTimer = null;

function planFirstRun(reason = null) {
  if (stopping || firstRunTimer) return;
  const due = firstRunAt(new Date(), env.startDelayMin);
  const delay = Math.max(0, due.getTime() - Date.now());
  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    if (stopping) return;
    runScheduled("catchup", new Date()).catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`the first run of the day crashed: ${text}`);
      residentNotice("run", `the first run of the day crashed: ${text}`);
    });
  }, delay);
  log(`first update of the day: at ${hhmm(due)} (in ${Math.round(delay / 60_000)} min${reason ? `, ${reason}` : ""}), unless everyone has already been covered today`);
}

/**
 * Ручная просьба свалилась на защите TikTok по адресу — назначаем один повтор через
 * `AMESTAT_MANUAL_RETRY_MIN` минут. Письма при назначении нет; если и повтор не удастся,
 * замечание придёт письмом самого обхода, как у обычного повтора.
 */
function planManualRetry(res, videos = "all", maxVideos = null) {
  if (stopping) return;
  const handles = addressProtectionHandles(res?.failures);
  if (handles.length === 0) return;
  const label = `${hhmm(new Date())} (manual request)`;
  planRetry(manualRetryAt(new Date(), env.manualRetryMin), label, { kind: "manual", handles, videos, maxVideos });
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
        const res = await launch({
          trigger: "manual",
          creatorId: group.creatorId,
          depth: group.depth,
          depthFrom: group.depthFrom,
          depthTo: group.depthTo,
          videos: group.videos,
          maxVideos: group.maxVideos,
          comments: group.comments,
          replies: group.replies,
          allVideos: group.allVideos,
          requestedBy: group.requestedBy,
          requestIds: group.ids,
        });
        // Свалила защита TikTok по адресу — через 25 минут попробуем сами, один раз.
        // Повтор идёт с охватом ИСХОДНОЙ просьбы: человек просил «только наши» — второй заход
        // не должен молча стать полным и стоить тех же минут, ради которых охват и заведён.
        // По той же причине наследуется и потолок числа видео (v19).
        planManualRetry(res, group.videos, group.maxVideos);
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
    return `not selected (${String(e?.message ?? e).split("\n")[0]})`;
  }
})();
// Прогрев: первые полторы минуты сеть только поднимается (особенно если компьютер спал), и
// её отказы владельцу не нужны — они уходят в лог и никуда больше.
startWarmup("startup");
// ⚠️ `range` слоту не разрешён вовсе (`env.mjs`): расписание ходит каждый день, а период —
// это один срез за конкретные числа. Опустили до «всё» — говорим об этом вслух.
if (env.slotDepthNote) log(`AMESTAT_SLOT_DEPTH: ${env.slotDepthNote}`);
// Зона слотов: опечатку в имени тоже говорим вслух — иначе расписание тихо уехало бы на час.
if (env.slotTzNote) log(`AMESTAT_SLOT_TZ: ${env.slotTzNote}`);
log(`resident started. Browser: ${browser}. Slots: ${env.slotHours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} in ${env.slotTz ?? "machine time"} (depth ${depthLabel(env.slotDepth)}). Pause between TikTok creators ${Math.round(env.pauseMs / 1000)} s. No more than ${env.ttLaunchLimit} TikTok launches per ${Math.round(env.ttWindowMs / 60_000)} min. First run of the day ${env.startDelayMin} min after startup. Retry after a failure in ${Math.round(env.retryMs / 60_000)} min, retry of a manual request in ${env.manualRetryMin} min. Instagram: ${env.igSource}. Logs: ${logsDir}`);

// 0. Остатки прошлых обходов: упавший обход оставляет окно Opera на нашем профиле, а оно и
//    память держит, и не даёт подняться следующему браузеру. Свои окна владельца не трогаем —
//    отбор идёт по нашему профилю в командной строке процесса.
try {
  const { killed, pids } = await killLeftoverBrowsers();
  if (killed > 0) {
    log(`Opera windows killed: ${killed} (${pids.join(", ")})`);
    residentNotice("browser", `Opera windows on our profiles killed at startup: ${killed}`);
  }
} catch (e) {
  log(`could not check for leftover Opera windows: ${String(e?.message ?? e).split("\n")[0]}`);
}

// Письма, придержанные ночью, уходят и при старте: компьютер могли выключить до 07:00, и
// очередь ждала бы тогда первой минуты тиканья впустую.
void flushNight({ log }).catch(() => {});

// 1. Часы: каждую минуту смотрим, не наступил ли слот.
let nextAt = nextSlot(new Date(), env.slotHours, env.slotTz);
log(`next slot: ${slotHhmm(nextAt, true)}${env.slotTz ? ` (${env.slotTz})` : ""}`);
let lastTickAt = Date.now();
const tick = setInterval(() => {
  const now = new Date();
  // Сирота мог появиться и после старта: разовый `run.mjs` убили окном терминала.
  void closeOrphanRuns();
  // Утро — отправить письма, придержанные ночью (владелец, 2026-09-19: «в 7:00 утра все
  // отправлялись разом»). Ночью и при пустой очереди это ничего не делает.
  void flushNight({ log }).catch(() => {});
  // Часы «прыгнули» — компьютер спал, а не тикал. Сеть после пробуждения встаёт не сразу,
  // поэтому её ближайшие отказы идут только в лог (прогрев).
  const slept = sleepGap(lastTickAt, now.getTime());
  lastTickAt = now.getTime();
  if (slept > 0) {
    log(`warm-up after sleep: ${slept} min passed`);
    startWarmup("sleep");
    // Машина могла проснуться утром НОВОГО дня — первый обход дня планируется тем же правилом,
    // что и при старте. Уже висящий таймер не трогаем и второго не заводим.
    planFirstRun("after sleep");
  }
  if (now >= nextAt) {
    const slot = nextAt;
    nextAt = nextSlot(now, env.slotHours, env.slotTz);
    log(`slot ${slotHhmm(slot)} — scheduled run. Next: ${slotHhmm(nextAt, true)}`);
    runScheduled("schedule", slot).catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`the scheduled run crashed: ${text}`);
      residentNotice("run", `the scheduled run crashed: ${text}`);
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
      residentNotice("realtime", `Realtime is back, the gap was ${step.say.minutes} min — requests are caught by the subscription again`);
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
      residentNotice("realtime", `Realtime has been down since ${hhmm(new Date(late.say.since))}, requests are caught by the once-a-minute poll`);
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
      log(`the request queue crashed: ${text}`);
      residentNotice("run", `the request queue crashed: ${text}`);
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
    const rows = await get("sync_requests?select=id,creator_id,requested_by,depth,depth_from,depth_to,videos,max_videos,comments,replies,all_videos,seen_at,taken_at&taken_at=is.null&order=id.asc");
    const fresh = [];
    for (const row of rows) {
      const id = remember(row, "poll");
      if (id === null) continue;
      fresh.push(id);
      // Просьбу должен приносить Realtime за секунды; опрос — страховка, и его находка значит
      // лаг до минуты. Первый опрос при старте — не лаг: он подбирает всё, что накопилось,
      // пока компьютер спал.
      residentNotice("poll", `request #${id} was caught by the poll, not by Realtime${firstPoll ? " (first poll at startup)" : ""}`);
    }
    dbResult("polling for requests", true);
    await markSeen(fresh);
    if (pending.size > 0) await drain();
  } catch (e) {
    const text = String(e?.message ?? e).split("\n")[0];
    log(`polling for requests failed: ${text}`);
    dbResult("polling for requests", false, text);
  } finally {
    firstPoll = false;
  }
}
await poll();
const polling = setInterval(() => { poll().catch(() => {}); }, POLL_MS);

// 4. Закрытие окна расчёта выплат (миграция v38). Раз в пять минут: у кого прошла отметка
//    «публикация + окно», а снимка после неё ещё нет — того обходим сразу.
//
// ⚠️ Заход короткий: глубина «неделя» (видео моложе окна), только наши видео, без
// комментариев и веток. Считать деньги нужны просмотры, а не тексты.
// ⚠️ Пока идёт любой другой обход — пропускаем: он сам поставит снимки, а второй браузер к
// тому же аккаунту TikTok отвечает пустотой.
// ⚠️ Письма в Telegram отсюда нет намеренно: данные этим не теряются — не закрыли сейчас,
// закроет ближайший обход, как было до v38.
// Когда к креатору уже ходили этим путём: не чаще раза в час (`RETRY_MS` в `window.mjs`).
// Память только в процессе — после перезапуска первая проверка сходит заново, и это не беда.
const windowTried = new Map();

async function closeWindows() {
  if (stopping || busy()) return;
  let rows;
  try {
    rows = await windowDue(MAX_AGE_HOURS);
    dbResult("checking the payout window", true);
  } catch (e) {
    const text = short(e);
    log(`could not check whose payout window has closed: ${text}`);
    dbResult("checking the payout window", false, text);
    return;
  }
  const runs = dueRuns(rows, 3, { tried: windowTried });
  if (runs.length === 0) return;
  log(`payout window closed for ${runs.map((r) => `@${r.handle} (${r.videos})`).join(", ")} — running them now`);
  for (const r of runs) {
    if (stopping || busy()) break;
    windowTried.set(r.creatorId, Date.now());
    const res = await launch({
      trigger: "window",
      creatorId: r.creatorId,
      depth: "week",
      videos: "ours",
      comments: false,
      replies: false,
    });
    if (!res.ok) log(`@${r.handle}: the window run did not go through — one more try in an hour, or the next full run closes it`);
  }
}
// ⚠️ При старте проверка НЕ зовётся: через пять минут и так идёт первый обход дня, он закроет
// всё накопившееся за ночь. Лишние запуски чистого профиля TikTok в эти же минуты только
// съели бы лимит (`tiktok-gate.mjs`) и задержали бы сам обход.
const windowTimer = setInterval(() => { closeWindows().catch(() => {}); }, WINDOW_MS);


/**
 * Закрыть обходы, оставшиеся открытыми от МЁРТВОГО процесса.
 *
 * ⚠️ Зачем (владелец, 2026-09-10): резидент перезапустили посреди обхода — процесс умер, а
 * строка `sync_runs` осталась без `finished_at`, и сайт четырнадцать минут показывал
 * «Обновляем», хотя не собиралось ничего. Признак сироты — молчание: живой обход двигает
 * `progress_at` после каждого креатора и каждого видео комментариев, мёртвый не двигает
 * вовсе. Порог намеренно большой: длинная прокрутка списка у крупного аккаунта тоже молчит
 * минутами, и живой обход задеть нельзя.
 * Свой текущий обход не трогается: `busy()` — про этот же процесс.
 */
const ORPHAN_MS = 15 * 60_000;

async function closeOrphanRuns(reason = "the process that was running it is gone") {
  if (busy()) return 0;
  try {
    const runs = await get("sync_runs?select=id,started_at,progress_at&finished_at=is.null&order=id.desc&limit=20");
    const edge = Date.now() - ORPHAN_MS;
    let closed = 0;
    for (const row of runs) {
      const moved = new Date(row.progress_at ?? row.started_at).getTime();
      if (!Number.isFinite(moved) || moved > edge) continue;
      await patch(`sync_runs?id=eq.${row.id}`, {
        finished_at: new Date().toISOString(),
        ok: false,
        error: `run interrupted: ${reason}`,
      });
      log(`run #${row.id} was left open — closed: ${reason}`);
      closed++;
    }
    return closed;
  } catch (e) {
    // Не вышло — сайт покажет «Обновляем» до следующего раза, но резидент из-за этого не встаёт.
    log(`could not check for open runs: ${short(e)}`);
    return 0;
  }
}

// ------------------------------------------------------------------ аккуратное завершение
let bye = false;
async function stop(signal) {
  if (bye) {
    log("second signal — exiting immediately");
    process.exit(1);
  }
  bye = true;
  stopping = true;
  log(`${signal}: stopping${busy() ? ", waiting for the current run to finish" : ""}`);
  // Обход этого процесса переживёт остановку только строкой в базе — и будет выглядеть идущим.
  // Закрываем его честно, чтобы кнопка на сайте не врала (владелец, 2026-09-10).
  if (busy()) {
    try {
      const runs = await get("sync_runs?select=id&finished_at=is.null&order=id.desc&limit=5");
      for (const row of runs) {
        await patch(`sync_runs?id=eq.${row.id}`, {
          finished_at: new Date().toISOString(),
          ok: false,
          error: `run interrupted: the resident was stopped (${signal})`,
        });
        log(`run #${row.id} marked as interrupted: the resident was stopped`);
      }
    } catch (e) {
      log(`the interrupted run was not marked: ${short(e)}`);
    }
  }
  clearInterval(tick);
  clearInterval(polling);
  clearInterval(windowTimer);
  if (retryTimer) {
    // Повтор не теряется: при следующем старте он восстановится по `sync_runs` через retryDue.
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (realtimeTimer) {
    clearTimeout(realtimeTimer);
    realtimeTimer = null;
  }
  if (firstRunTimer) {
    // Первый обход дня ждал своих минут — при следующем старте он назначится заново.
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  try {
    await channel.unsubscribe();
    await supabase.removeAllChannels();
  } catch {
    // Подписка могла уже отвалиться — на выход это не влияет.
  }
  await lastRun;
  log("stopped");
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
  if (due && !stopping) planRetry(due, slotHhmm(new Date(scheduled.started_at)), { fresh: false });
  else log("no pending retries");

// 4а. Обходы, оставшиеся открытыми от прошлого процесса: их некому закрыть, а сайт по ним
//     показывает «Обновляем». Проверяем при старте и потом раз в минуту вместе с часами.
void closeOrphanRuns("the resident was restarted");
} catch (e) {
  const text = String(e?.message ?? e).split("\n")[0];
  log(`the retry was not restored: ${text}`);
  residentNotice("db", `the retry was not restored: ${text}`);
}

// 5. Первый обход дня — последним делом: он ждёт своих минут в таймере, а часы, Realtime,
//    опрос и обработчик Ctrl+C к этому времени уже работают. Сам обход занимает минуты, и
//    просьба с сайта не должна ждать его конца незамеченной.
planFirstRun();

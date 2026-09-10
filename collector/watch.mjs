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
//      ⚠️ Слот ПРОПУСКАЕТСЯ, если сегодня до него уже завершился обход по всем креаторам —
//      неважно, по кнопке с сайта, руками или первым обходом дня (владелец, 2026-09-09).
//      Второй заход браузера в тот же день не приносит новых цифр, а TikTok от очереди
//      запусков отвечает пустотой. То же правило действует и на первый обход дня.
//   3. Кнопка «Обновить» на сайте — строка в `sync_requests` (`manual`). Слышим её через
//      Realtime, а раз в минуту ещё и спрашиваем базу сами: подписка умеет тихо отвалиться,
//      и тогда просьба владельца висела бы до перезапуска.
//   4. Повтор через час после неудачного обхода по расписанию (`retry`) — только по тем
//      креаторам, у кого осталась ошибка.
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
import {
  nextSlot, retryDue, firstRunAt,
  slotAlreadyCovered, addressProtectionHandles, manualRetryAt, retryStillNeeded,
} from "./schedule.mjs";
import { logSystem } from "./synclog.mjs";
import { groupRequests } from "./requests.mjs";
import { depthLabel, normalizeDepth, videoCap } from "./scope.mjs";
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
  // Глубина и края периода (миграция v18). Незнакомое слово и «период» без границ опускаются
  // до «всё» — со строкой в лог: молча подменённая глубина хуже, чем громко подменённая.
  const { depth, from: depthFrom, to: depthTo, note } = normalizeDepth(row.depth, row.depth_from ?? null, row.depth_to ?? null);
  if (note) log(`просьба #${id}: ${note}`);
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
  log(`просьба #${id} (${row.creator_id ? `креатор ${row.creator_id}` : "все"}, глубина ${depthLabel(depth, depthFrom, depthTo)}, комментарии ${comments ? "да" : "нет"}, ветки ${replies ? "да" : "нет"}${allVideos ? ", и не наши видео" : ""}${videos === "ours" ? " · только наши" : ""}${maxVideos !== null ? ` · до ${maxVideos} видео` : ""}) — ${source}`);
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
function planRetry(due, slotLabel, { fresh = false, kind = "schedule", handles = [], videos = "all", maxVideos = null } = {}) {
  if (retryTimer) {
    log(`повтор уже назначен на ${retryAt.toLocaleString()} — второй не завожу`);
    return;
  }
  retryAt = due;
  const delay = Math.max(0, due.getTime() - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = null;
    runRetry(slotLabel, { handles, videos, maxVideos }).catch((e) => {
      const text = String(e?.message ?? e).split("\n")[0];
      log(`повтор сорвался: ${text}`);
      residentNotice("run", `повтор сорвался: ${text}`);
    });
  }, delay);
  if (kind === "manual") {
    // Повтор ручной просьбы: письма при назначении нет вовсе — человек стоит у сайта и
    // видит там и неудачу, и следующий обход. В журнал сайта строка всё же уходит.
    const text = `повтор ручной просьбы назначен на ${hhmm(due)} (через ${Math.round(delay / 60_000)} мин): защита TikTok по адресу у ${handles.map((h) => `@${h}`).join(", ")}`;
    log(text);
    void logSystem(text, { level: "warn" });
    return;
  }
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

async function runRetry(slotLabel, { handles = [], videos = "all", maxVideos = null } = {}) {
  if (stopping) return;
  const retryLabel = hhmm(new Date());

  // Ошибки могло уже не остаться: следующий слот, догон или просьба с сайта успели собрать всех.
  let failedCreators;
  try {
    failedCreators = await get("creators?select=id,handle,sync_error&sync_error=not.is.null");
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
  // Повтор ручной просьбы назван поимённо: к сроку по ТЕМ креаторам мог пройти удачный обход,
  // и тогда будить браузер незачем — чужие ошибки этот повтор не чинит.
  if (handles.length > 0 && !retryStillNeeded(failedCreators, handles)) {
    const text = `повтор ручной просьбы отменён: по ${handles.map((h) => `@${h}`).join(", ")} уже прошёл удачный обход`;
    log(text);
    void logSystem(text, { level: "info" });
    return;
  }

  log(`повтор по неудавшимся (${failedCreators.map((c) => `@${c.handle}`).join(", ")})`);
  // `slotLabel` уходит в обход: неудача повтора скажется строкой в его собственном письме,
  // а второго письма (прежний `callOwner`) больше нет.
  // Расписание, догон и повтор всегда снимают всё: комментарии и ветки. Галочки бывают только
  // у просьбы с сайта — там их ставит человек.
  // ⚠️ Охват и потолок — исключение: повтор ПОСЛЕ РУЧНОЙ просьбы наследует её охват («только
  // наши») и её потолок («до N видео»), а повтор после слота идёт с полным охватом и без
  // потолка, как и сам слот.
  const res = await launch({ trigger: "retry", failedOnly: true, depth: env.slotDepth, videos, maxVideos, comments: true, replies: true, slotLabel });
  if (!res.ok) log(`вторая неудача подряд после слота ${slotLabel} — сказано письмом обхода #${res.runId ?? "?"}`);
}

/**
 * Был ли сегодня, до сих пор, завершённый обход по ВСЕМ креаторам. Отдаёт момент его конца
 * или null. База не ответила — считаем, что не было: пропустить слот из-за молчания базы
 * значит потерять сегодняшний срез, а лишний обход всего лишь стоит времени.
 */
async function coveredToday(now = new Date()) {
  try {
    const runs = await get("sync_runs?select=scope,finished_at&scope=eq.all&finished_at=not.is.null&order=finished_at.desc&limit=10");
    return slotAlreadyCovered(now, runs, env.slotTz);
  } catch (e) {
    const text = String(e?.message ?? e).split("\n")[0];
    log(`не спросилось, был ли сегодня обход по всем: ${text}`);
    dbResult("проверка сегодняшнего обхода", false, text);
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
  const covered = await coveredToday();
  if (covered) {
    const text = `слот ${label} пропущен: сегодня уже был обход по всем в ${slotHhmm(covered)}`;
    log(text);
    void logSystem(text, { level: "info" });
    return { ok: true, skipped: true, done: 0, failed: 0, runId: null };
  }
  const res = await launch({ trigger, depth: env.slotDepth, comments: true, replies: true });
  if (!res.ok && !stopping) planRetry(new Date(Date.now() + env.retryMs), label, { fresh: true });
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
      log(`первый обход дня сорвался: ${text}`);
      residentNotice("run", `первый обход дня сорвался: ${text}`);
    });
  }, delay);
  log(`первое обновление дня: в ${hhmm(due)} (через ${Math.round(delay / 60_000)} мин${reason ? `, ${reason}` : ""}), если сегодня ещё не обходили всех`);
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
  const label = `${hhmm(new Date())} (ручная просьба)`;
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
    return `не выбран (${String(e?.message ?? e).split("\n")[0]})`;
  }
})();
// Прогрев: первые полторы минуты сеть только поднимается (особенно если компьютер спал), и
// её отказы владельцу не нужны — они уходят в лог и никуда больше.
startWarmup("старта");
// ⚠️ `range` слоту не разрешён вовсе (`env.mjs`): расписание ходит каждый день, а период —
// это один срез за конкретные числа. Опустили до «всё» — говорим об этом вслух.
if (env.slotDepthNote) log(`AMESTAT_SLOT_DEPTH: ${env.slotDepthNote}`);
// Зона слотов: опечатку в имени тоже говорим вслух — иначе расписание тихо уехало бы на час.
if (env.slotTzNote) log(`AMESTAT_SLOT_TZ: ${env.slotTzNote}`);
log(`резидент запущен. Браузер: ${browser}. Слоты: ${env.slotHours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} по ${env.slotTz ?? "времени машины"} (глубина ${depthLabel(env.slotDepth)}). Пауза между креаторами TikTok ${Math.round(env.pauseMs / 1000)} с. Запусков TikTok не больше ${env.ttLaunchLimit} за ${Math.round(env.ttWindowMs / 60_000)} мин. Первый обход дня через ${env.startDelayMin} мин после старта. Повтор после неудачи через ${Math.round(env.retryMs / 60_000)} мин, повтор ручной просьбы через ${env.manualRetryMin} мин. Instagram: ${env.igSource}. Логи: ${logsDir}`);

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
let nextAt = nextSlot(new Date(), env.slotHours, env.slotTz);
log(`следующий слот: ${slotHhmm(nextAt, true)}${env.slotTz ? ` (${env.slotTz})` : ""}`);
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
    // Машина могла проснуться утром НОВОГО дня — первый обход дня планируется тем же правилом,
    // что и при старте. Уже висящий таймер не трогаем и второго не заводим.
    planFirstRun("после сна");
  }
  if (now >= nextAt) {
    const slot = nextAt;
    nextAt = nextSlot(now, env.slotHours, env.slotTz);
    log(`слот ${slotHhmm(slot)} — обход по расписанию. Следующий: ${slotHhmm(nextAt, true)}`);
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
    const rows = await get("sync_requests?select=id,creator_id,requested_by,depth,depth_from,depth_to,videos,max_videos,comments,replies,all_videos,seen_at,taken_at&taken_at=is.null&order=id.asc");
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
  if (due && !stopping) planRetry(due, slotHhmm(new Date(scheduled.started_at)), { fresh: false });
  else log("несделанных повторов нет");
} catch (e) {
  const text = String(e?.message ?? e).split("\n")[0];
  log(`повтор не восстановлен: ${text}`);
  residentNotice("db", `повтор не восстановлен: ${text}`);
}

// 5. Первый обход дня — последним делом: он ждёт своих минут в таймере, а часы, Realtime,
//    опрос и обработчик Ctrl+C к этому времени уже работают. Сам обход занимает минуты, и
//    просьба с сайта не должна ждать его конца незамеченной.
planFirstRun();

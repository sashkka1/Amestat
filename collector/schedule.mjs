// Расписание обходов: слоты в день по выбранной зоне, и один повтор через час, если обход
// по расписанию не удался.
//
// ⚠️ У владельца слотов ДВА — 7:00 и 16:00 (2026-09-09), и стоят они в `.env.local`
// (`AMESTAT_SLOTS=7,16`). Умолчание кода на случай пустой настройки прежнее — один слот 13:00.
//
// 🔴 Зона слотов — `AMESTAT_SLOT_TZ` (IANA, например `Europe/Warsaw`); пусто — зона машины,
// как было всегда. Владелец, 2026-09-09: «7:00 и 16:00 по UTC+2 с учётом перехода на зимнее
// время». Числом смещение задать нельзя именно поэтому: UTC+2 живёт полгода, а в конце октября
// та же Варшава становится UTC+1, и слот «7:00» уехал бы на 8:00 по часам владельца. Зона
// держит ЧАС ПО СТЕННЫМ ЧАСАМ, а смещение считает сама.
//
// Пересчёт — `Intl.DateTimeFormat` с `timeZone`, без единой внешней библиотеки: у зоны
// спрашивается, который в ней час в данный миг, отсюда её смещение, отсюда — миг, в который
// её стенные часы покажут нужное.
//
// Здесь только чистые функции — ни базы, ни таймеров, ни побочных действий, ни даже чтения
// настроек: часы слотов и зона приходят параметрами (`env.slotHours`, `env.slotTz`).
// Так их можно проверить тестами (`schedule.test.mjs`), а резидент `watch.mjs` просто
// спрашивает у них, что делать: пора ли по расписанию, не проспали ли слот, не был ли он уже
// сегодня закрыт другим обходом, и не висит ли несделанный повтор после неудачи.

/** Часы по умолчанию, если `AMESTAT_SLOTS` пуст или в нём мусор. */
export const DEFAULT_SLOTS = [13];

/**
 * Разбор `AMESTAT_SLOTS`: `13` или `10,13,17`. Мусор и пустота — `fallback`.
 * Часы приводятся к целым 0–23, дубли убираются, порядок — по возрастанию.
 * Чистая функция: её проверяют тесты, а `env.mjs` зовёт её у себя.
 */
export function parseSlots(raw, fallback = DEFAULT_SLOTS) {
  const hours = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 23);
  const uniq = [...new Set(hours)].sort((a, b) => a - b);
  return uniq.length > 0 ? uniq : [...fallback];
}

/**
 * Часы слотов по умолчанию — на случай, если звать функции без параметра. Настоящие часы
 * приходят из `.env.local` (`env.slotHours`) и передаются вторым аргументом: модуль остаётся
 * чистым, а тесты подставляют любое расписание.
 */
export const SLOT_HOURS = [...DEFAULT_SLOTS];

// ------------------------------------------------------------------------------- зона слотов

/**
 * Имя зоны, если оно годится, иначе `null` («зона машины»). Проверка одна и настоящая: зону
 * пробует сам `Intl`, а он на незнакомом имени бросает RangeError.
 * Чистая функция; её же зовёт `env.mjs`, чтобы сказать владельцу про опечатку строкой в лог.
 */
export function zoneOf(tz) {
  const name = String(tz ?? "").trim();
  if (name === "") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

// Форматирователи стоят денег — по одному на зону, и он же переиспользуется.
const zoneFormats = new Map();

function zoneFormat(tz) {
  let fmt = zoneFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    zoneFormats.set(tz, fmt);
  }
  return fmt;
}

/** Что показывают стенные часы зоны в этот миг: `{ year, month, day, hour, minute, second }`. */
function zoneParts(tz, ms) {
  const out = {};
  for (const { type, value } of zoneFormat(tz).formatToParts(new Date(ms))) {
    if (type !== "literal") out[type] = Number(value);
  }
  return out;
}

/**
 * Смещение зоны от UTC в мс В ЭТОТ МИГ (летом у Варшавы +2 ч, зимой +1). Считается вычитанием:
 * «сколько показывают её часы» минус «сколько показывает UTC».
 */
function zoneOffset(tz, ms) {
  const p = zoneParts(tz, ms);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Календарный день (`{ y, m, d }`), к которому принадлежит миг `date` в зоне (пусто — машина). */
function dayIn(date, tz) {
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!tz) {
    const local = new Date(ms);
    return { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() };
  }
  const p = zoneParts(tz, ms);
  return { y: p.year, m: p.month, d: p.day };
}

/** Тот же день плюс-минус сутки — календарём, а не «плюс 24 часа»: в день перевода их 23 или 25. */
function shiftDay({ y, m, d }, delta) {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Миг, в который стенные часы зоны покажут `hour:00` этого календарного дня.
 * Два прохода: первое смещение берётся у примерного мига, второе — у уточнённого. Иначе в
 * сутки перевода час съезжал бы на 60 минут — а именно ради них зона и заведена.
 */
function instantOf(cal, hour, tz) {
  if (!tz) return new Date(cal.y, cal.m - 1, cal.d, hour, 0, 0, 0);
  const wall = Date.UTC(cal.y, cal.m - 1, cal.d, hour, 0, 0, 0);
  const first = wall - zoneOffset(tz, wall);
  return new Date(wall - zoneOffset(tz, first));
}

/** Слоты одного календарного дня. */
function slotsForDay(cal, hours, tz) {
  return (hours ?? []).map((h) => instantOf(cal, h, tz));
}

/**
 * Слоты того дня, к которому принадлежит `day`. `tz` — зона слотов (IANA); пусто или мусор —
 * зона машины, как было всегда. Чистая функция: её проверяют тесты, в том числе на сутки
 * летнего и зимнего перевода.
 */
export function slotsOf(day, hours = SLOT_HOURS, tz = null) {
  const zone = zoneOf(tz);
  return slotsForDay(dayIn(day, zone), hours, zone);
}

/** Ближайший слот строго после `now`. После последнего слота — первый слот завтра. */
export function nextSlot(now, hours = SLOT_HOURS, tz = null) {
  const zone = zoneOf(tz);
  for (const slot of slotsForDay(dayIn(now, zone), hours, zone)) if (slot > now) return slot;
  return slotsForDay(shiftDay(dayIn(now, zone), 1), hours, zone)[0];
}

/**
 * Пропущенный слот: последний слот не позже `now`, после которого обхода не было.
 *
 *   `lastStartedAt` = null → сегодняшний последний прошедший слот (или null, если сегодня
 *   ещё ни одного не было). Вчерашние не догоняем: смысл догона — не потерять сегодняшний срез.
 *   Иначе → последний слот из промежутка (lastStartedAt; now]. Компьютер проспал два слота —
 *   вернётся только поздний: догоняем один раз, а не столько же раз, сколько проспали.
 */
export function missedSlot(now, lastStartedAt, hours = SLOT_HOURS, tz = null) {
  const zone = zoneOf(tz);
  if (!lastStartedAt) {
    const passed = slotsForDay(dayIn(now, zone), hours, zone).filter((slot) => slot <= now);
    return passed.at(-1) ?? null;
  }
  const last = lastStartedAt instanceof Date ? lastStartedAt : new Date(lastStartedAt);
  if (Number.isNaN(last.getTime())) return missedSlot(now, null, hours, zone);

  const all = [];
  // Дни перебираются календарём зоны, а не прибавлением суток: в ночь перевода их 23 или 25.
  let cursor = dayIn(last, zone);
  const end = dayIn(now, zone);
  const key = ({ y, m, d }) => y * 10000 + m * 100 + d;
  for (let i = 0; key(cursor) <= key(end) && i < 400; i++) {
    all.push(...slotsForDay(cursor, hours, zone));
    cursor = shiftDay(cursor, 1);
  }
  const missed = all.filter((slot) => slot <= now && slot > last);
  return missed.at(-1) ?? null;
}

/**
 * Был ли сегодня, до `now`, ЗАВЕРШЁННЫЙ обход по всем креаторам. Отдаёт момент его конца или
 * null. Владелец, 2026-09-09: слот не должен гнать браузер второй раз за день, если по всем
 * креаторам уже прошлись — хоть по кнопке с сайта, хоть руками, хоть догоном.
 *
 * Что считается за «обход по всем»: `scope = 'all'` и непустой `finished_at`. Повод (`trigger`)
 * и итог (`ok`) значения не имеют — даже неудачный обход по всем побывал у каждого креатора и
 * второй заход в тот же день ничего не чинит: на это есть повтор через час.
 *
 * `runs` — строки `sync_runs` `{ scope, finished_at }` (порядок любой).
 * ⚠️ «Сегодня» считается в ТОЙ ЖЕ зоне, что и слоты (`tz`; пусто — зона машины): иначе у
 * машины, живущей на другом часовом поясе, сутки кончались бы не там, где кончается день
 * расписания, и утренний слот считал бы вчерашний вечерний обход своим. Чистая функция.
 */
export function slotAlreadyCovered(now, runs, tz = null) {
  const zone = zoneOf(tz);
  const today = dayIn(now, zone);
  let latest = null;
  for (const row of runs ?? []) {
    if ((row?.scope ?? "") !== "all") continue;
    const finished = asDate(row?.finished_at);
    if (!finished || finished > now) continue;
    const day = dayIn(finished, zone);
    const sameDay = day.y === today.y && day.m === today.m && day.d === today.d;
    if (!sameDay) continue;
    if (!latest || finished > latest) latest = finished;
  }
  return latest;
}

/** Дата из строки базы или Date; мусор и пустота → null. */
function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Когда повторять неудавшийся обход по расписанию — или null, если повторять нечего.
 *
 *   `lastScheduled` — последний обход с поводом `schedule` или `catchup`:
 *                     `{ started_at, finished_at, ok }`. Успех или «ещё идёт» (ok = null) —
 *                     повтора нет.
 *   `lastRetry`     — последний обход с поводом `retry` (или null). Начат после конца
 *                     неудачного обхода — значит повтор уже был, второго не будет:
 *                     следующий шанс у расписания, а не у нас.
 *   `retryMs`       — через сколько повторять (AMESTAT_RETRY_MIN, по умолчанию час).
 *
 * Ответ — момент повтора: `finished_at` неудачного обхода плюс `retryMs`. Он может быть уже
 * в прошлом (компьютер спал, резидент только поднялся) — тогда повторять надо сразу.
 *
 * Момент считается от конца неудачного обхода, а не от «сейчас», иначе перезапуск резидента
 * каждый раз откладывал бы повтор ещё на час. `now` нужен только для давности: неудача
 * старше `maxAgeMs` (сутки) не восстанавливается — с тех пор прошли свои слоты, и повтор
 * недельной давности ничего не чинит, а только лишний раз будит браузер.
 */
export function retryDue(now, lastScheduled, lastRetry, retryMs = 60 * 60_000, maxAgeMs = 24 * 60 * 60_000) {
  if (!lastScheduled || lastScheduled.ok !== false) return null;
  // finished_at пуст только у оборванного обхода (резидент убит посреди дела) — тогда
  // отсчитываем от начала: лучше повторить раньше, чем не повторить вовсе.
  const finished = asDate(lastScheduled.finished_at) ?? asDate(lastScheduled.started_at);
  if (!finished) return null;
  if (now.getTime() - finished.getTime() > maxAgeMs) return null;
  const retried = asDate(lastRetry?.started_at);
  if (retried && retried >= finished) return null;
  return new Date(finished.getTime() + retryMs);
}

// ------------------------------------------------------------------ повтор ручной просьбы
// Владелец, 2026-09-09: TikTok «дросселит» домашний адрес, и ручная просьба, попавшая в такую
// минуту, возвращается пустыми списками у всех. Ждать до завтрашнего слота глупо: через
// AMESTAT_MANUAL_RETRY_MIN минут защита обычно отпускает, и повтор идёт сам.

/** Как выглядит ошибка «TikTok не отдал список из-за защиты по адресу» — здесь и в `tiktok.mjs`. */
export const ADDRESS_ERROR_RE = /защита по адресу/i;

/**
 * Кого из неудавшихся креаторов свалила защита по адресу.
 * `failures` — `[{ handle, error }]` из итога обхода. Отдаёт список handle'ов (без повторов).
 * Чистая функция: её проверяют тесты.
 */
export function addressProtectionHandles(failures) {
  const out = [];
  for (const f of failures ?? []) {
    if (!ADDRESS_ERROR_RE.test(String(f?.error ?? ""))) continue;
    const handle = String(f?.handle ?? "").trim();
    if (handle && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/**
 * Момент повтора ручной просьбы: `now` плюс `minutes` (AMESTAT_MANUAL_RETRY_MIN, по умолчанию 25).
 * Отдельная функция, а не `now + x` по месту, — чтобы момент считался одинаково и в тестах.
 */
export function manualRetryAt(now, minutes = 25) {
  const min = Number.isFinite(minutes) && minutes > 0 ? minutes : 25;
  return new Date(now.getTime() + Math.round(min * 60_000));
}

/**
 * Нужен ли ещё назначенный повтор ручной просьбы. Нет — если у всех тех креаторов ошибка уже
 * снята: значит между просьбой и сроком по ним прошёл удачный обход, и будить браузер незачем.
 * `creators` — строки `creators` `{ handle, sync_error }`, у которых ошибка осталась.
 * Чистая функция: её проверяют тесты.
 */
export function retryStillNeeded(creators, handles) {
  const want = new Set((handles ?? []).map((h) => String(h).replace(/^@/, "").toLowerCase()));
  if (want.size === 0) return false;
  return (creators ?? []).some((c) => {
    const handle = String(c?.handle ?? "").replace(/^@/, "").toLowerCase();
    return want.has(handle) && Boolean(c?.sync_error);
  });
}

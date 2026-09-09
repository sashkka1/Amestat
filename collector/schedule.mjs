// Расписание обходов: слоты в день по местному времени компьютера, и один повтор через час,
// если обход по расписанию не удался.
//
// ⚠️ Слот теперь ОДИН — 13:00 (владелец, 2026-09-09). Три обхода в день стоили трёх заходов
// браузера к каждому креатору, а TikTok от очереди запусков с одного адреса отвечает пустотой.
// Другое расписание задаётся `AMESTAT_SLOTS` в `.env.local` (`13` или `10,13,17`).
//
// Здесь только чистые функции — ни базы, ни таймеров, ни побочных действий, ни даже чтения
// настроек: часы слотов приходят параметром (`env.slotHours`, разобранные `parseSlots`).
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

/** Слоты того дня, к которому принадлежит `day` (местное время). */
export function slotsOf(day, hours = SLOT_HOURS) {
  return hours.map((h) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0));
}

/** Ближайший слот строго после `now`. После последнего слота — первый слот завтра. */
export function nextSlot(now, hours = SLOT_HOURS) {
  for (const slot of slotsOf(now, hours)) if (slot > now) return slot;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return slotsOf(tomorrow, hours)[0];
}

/**
 * Пропущенный слот: последний слот не позже `now`, после которого обхода не было.
 *
 *   `lastStartedAt` = null → сегодняшний последний прошедший слот (или null, если сегодня
 *   ещё ни одного не было). Вчерашние не догоняем: смысл догона — не потерять сегодняшний срез.
 *   Иначе → последний слот из промежутка (lastStartedAt; now]. Компьютер проспал два слота —
 *   вернётся только поздний: догоняем один раз, а не столько же раз, сколько проспали.
 */
export function missedSlot(now, lastStartedAt, hours = SLOT_HOURS) {
  if (!lastStartedAt) {
    const passed = slotsOf(now, hours).filter((slot) => slot <= now);
    return passed.at(-1) ?? null;
  }
  const last = lastStartedAt instanceof Date ? lastStartedAt : new Date(lastStartedAt);
  if (Number.isNaN(last.getTime())) return missedSlot(now, null, hours);

  const all = [];
  const cursor = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  for (let i = 0; cursor <= end && i < 400; i++) {
    all.push(...slotsOf(cursor, hours));
    cursor.setDate(cursor.getDate() + 1);
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
 * `runs` — строки `sync_runs` `{ scope, finished_at }` (порядок любой). Чистая функция.
 */
export function slotAlreadyCovered(now, runs) {
  let latest = null;
  for (const row of runs ?? []) {
    if ((row?.scope ?? "") !== "all") continue;
    const finished = asDate(row?.finished_at);
    if (!finished || finished > now) continue;
    const sameDay = finished.getFullYear() === now.getFullYear()
      && finished.getMonth() === now.getMonth()
      && finished.getDate() === now.getDate();
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

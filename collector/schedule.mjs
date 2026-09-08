// Расписание обходов: три слота в день по местному времени компьютера, и один повтор через
// час, если обход по расписанию не удался.
//
// Здесь только чистые функции — ни базы, ни таймеров, ни побочных действий. Так их можно
// проверить тестами (`schedule.test.mjs`), а резидент `watch.mjs` просто спрашивает у них,
// что делать: пора ли по расписанию, не проспали ли слот, пока компьютер спал, и не висит ли
// на нём несделанный повтор после неудачи.

export const SLOT_HOURS = [10, 13, 17];

/** Слоты того дня, к которому принадлежит `day` (местное время). */
export function slotsOf(day) {
  return SLOT_HOURS.map((h) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0));
}

/** Ближайший слот строго после `now`. После последнего слота — первый слот завтра. */
export function nextSlot(now) {
  for (const slot of slotsOf(now)) if (slot > now) return slot;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return slotsOf(tomorrow)[0];
}

/**
 * Пропущенный слот: последний слот не позже `now`, после которого обхода не было.
 *
 *   `lastStartedAt` = null → сегодняшний последний прошедший слот (или null, если сегодня
 *   ещё ни одного не было). Вчерашние не догоняем: смысл догона — не потерять сегодняшний срез.
 *   Иначе → последний слот из промежутка (lastStartedAt; now]. Компьютер проспал два слота —
 *   вернётся только поздний: догоняем один раз, а не столько же раз, сколько проспали.
 */
export function missedSlot(now, lastStartedAt) {
  if (!lastStartedAt) {
    const passed = slotsOf(now).filter((slot) => slot <= now);
    return passed.at(-1) ?? null;
  }
  const last = lastStartedAt instanceof Date ? lastStartedAt : new Date(lastStartedAt);
  if (Number.isNaN(last.getTime())) return missedSlot(now, null);

  const all = [];
  const cursor = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  for (let i = 0; cursor <= end && i < 400; i++) {
    all.push(...slotsOf(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const missed = all.filter((slot) => slot <= now && slot > last);
  return missed.at(-1) ?? null;
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

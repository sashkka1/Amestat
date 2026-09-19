// Тесты расписания: `npm test` в collector.
// Даты берутся местные (new Date(год, месяц, день, час)) — слоты тоже местные.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slotsOf, nextSlot, missedSlot, retryDue, SLOT_HOURS, DEFAULT_SLOTS, parseSlots,
  slotAlreadyCovered, coveredRecently, addressProtectionHandles, manualRetryAt, retryStillNeeded, zoneOf,
  firstRunAt,
} from "./schedule.mjs";

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const hm = (date) => (date === null ? null : `${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`);
// Прежнее расписание: часы теперь приходят параметром из `AMESTAT_SLOTS`, а не константой.
const THREE = [10, 13, 17];

// ------------------------------------------------------------------ часы из настроек
// Умолчание кода — 16:00 (владелец, 2026-09-10: утренний слот выключен, пустая переменная не
// должна воскрешать прежние 13:00).
test("by default there is one slot — 16:00", () => {
  assert.deepEqual(DEFAULT_SLOTS, [16]);
  assert.deepEqual(SLOT_HOURS, [16]);
  assert.deepEqual(slotsOf(at(2026, 9, 8, 23, 59)).map(hm), ["8 16:00"]);
});

test("AMESTAT_SLOTS: one hour, a list, garbage and emptiness", () => {
  assert.deepEqual(parseSlots("13"), [13]);
  assert.deepEqual(parseSlots("10,13,17"), [10, 13, 17]);
  assert.deepEqual(parseSlots(" 17 , 10 "), [10, 17], "ascending order, spaces do not get in the way");
  assert.deepEqual(parseSlots("13,13"), [13], "duplicates are removed");
  assert.deepEqual(parseSlots(""), [16]);
  assert.deepEqual(parseSlots(undefined), [16]);
  assert.deepEqual(parseSlots("in the evening"), [16], "garbage means the default schedule");
  assert.deepEqual(parseSlots("25,-1,9.5"), [16], "there are no hours outside the day and no fractional ones");
  assert.deepEqual(parseSlots("0"), [0], "midnight is a lawful hour, not emptiness");
});

test("a single 16:00 slot: the next one, the catch-up and midnight", () => {
  assert.equal(hm(nextSlot(at(2026, 9, 8, 9, 0))), "8 16:00");
  assert.equal(hm(nextSlot(at(2026, 9, 8, 17, 0))), "9 16:00", "after the slot — tomorrow's one");
  assert.equal(missedSlot(at(2026, 9, 8, 9, 0), null), null, "before the slot there is nothing to catch up");
  assert.equal(hm(missedSlot(at(2026, 9, 8, 20, 0), null)), "8 16:00");
  assert.equal(missedSlot(at(2026, 9, 8, 20, 0), at(2026, 9, 8, 16, 2)), null, "the slot has been worked");
});

// --------------------------------------------------- зона слотов (владелец, 2026-09-09)
// Проверки нарочно сравнивают МГНОВЕНИЯ (ISO с Z), а не местные часы: тесты должны давать один
// ответ на любой машине. Варшава летом UTC+2, зимой UTC+1; переводы 2026 — 29 марта и 25 октября.
const TZ = "Europe/Warsaw";
const TWO = [7, 16];
const iso = (date) => (date === null ? null : date.toISOString());

test("the zone name: a valid one is taken, empty and garbage mean machine time", () => {
  assert.equal(zoneOf(TZ), TZ);
  assert.equal(zoneOf(" UTC "), "UTC", "spaces at the edges do not count");
  assert.equal(zoneOf(""), null);
  assert.equal(zoneOf(undefined), null);
  assert.equal(zoneOf("Europe/Warszawa"), null, "we do not silently swallow a typo in the zone name");
  assert.equal(zoneOf("UTC+2"), null, "a zone is not set by an offset — the offset lives half a year");
});

test("slots 7 and 16 in a zone: one offset in summer, another in winter", () => {
  const summer = slotsOf(new Date("2026-07-15T00:00:00Z"), TWO, TZ);
  assert.deepEqual(summer.map(iso), ["2026-07-15T05:00:00.000Z", "2026-07-15T14:00:00.000Z"], "in summer +2");
  const winter = slotsOf(new Date("2026-12-15T00:00:00Z"), TWO, TZ);
  assert.deepEqual(winter.map(iso), ["2026-12-15T06:00:00.000Z", "2026-12-15T15:00:00.000Z"], "in winter +1");
});

test("the day the clocks change: the same hour on the wall clock, a different instant", () => {
  // 29 марта стрелки вперёд (02:00 → 03:00), 25 октября назад (03:00 → 02:00).
  assert.equal(iso(slotsOf(new Date("2026-03-28T12:00:00Z"), [7], TZ)[0]), "2026-03-28T06:00:00.000Z");
  assert.equal(iso(slotsOf(new Date("2026-03-29T12:00:00Z"), [7], TZ)[0]), "2026-03-29T05:00:00.000Z");
  assert.equal(iso(slotsOf(new Date("2026-10-24T12:00:00Z"), [7], TZ)[0]), "2026-10-24T05:00:00.000Z");
  assert.equal(iso(slotsOf(new Date("2026-10-25T12:00:00Z"), [7], TZ)[0]), "2026-10-25T06:00:00.000Z");
});

test("the day of the slots is the day of the ZONE, not of the machine", () => {
  // 22:30 UTC — в Варшаве уже полпервого ночи следующего дня.
  const slots = slotsOf(new Date("2026-07-15T22:30:00Z"), [7], TZ);
  assert.equal(iso(slots[0]), "2026-07-16T05:00:00.000Z");
});

test("the next and the missed slot in a zone survive the clock change", () => {
  assert.equal(iso(nextSlot(new Date("2026-10-25T06:30:00Z"), TWO, TZ)), "2026-10-25T15:00:00.000Z");
  assert.equal(iso(nextSlot(new Date("2026-10-25T15:30:00Z"), TWO, TZ)), "2026-10-26T06:00:00.000Z", "after the last one — tomorrow's morning slot");
  // Компьютер спал сутки: последний обход — вечерний слот 24-го (16:00 ещё по летнему времени).
  assert.equal(
    iso(missedSlot(new Date("2026-10-25T14:00:00Z"), new Date("2026-10-24T14:00:00Z"), TWO, TZ)),
    "2026-10-25T06:00:00.000Z",
    "we catch up the morning slot of the 25th, already on winter time",
  );
  assert.equal(iso(missedSlot(new Date("2026-07-15T13:00:00Z"), null, TWO, TZ)), "2026-07-15T05:00:00.000Z");
  assert.equal(missedSlot(new Date("2026-07-15T13:00:00Z"), new Date("2026-07-15T05:02:00Z"), TWO, TZ), null, "the morning slot has been worked");
});

test("\"there was already a run over everyone today\" is counted by the zone's day", () => {
  const now = new Date("2026-09-09T23:00:00Z");   // в Варшаве 01:00 десятого
  const run = (isoText) => ({ scope: "all", finished_at: isoText });
  assert.equal(slotAlreadyCovered(now, [run("2026-09-09T21:00:00Z")], TZ), null, "23:00 of the ninth in the zone — yesterday");
  assert.equal(
    iso(slotAlreadyCovered(now, [run("2026-09-09T22:30:00Z")], TZ)),
    "2026-09-09T22:30:00.000Z",
    "00:30 of the tenth in the zone — today",
  );
});

test("the slots of the day are 10:00, 13:00, 17:00 of that same day", () => {
  const slots = slotsOf(at(2026, 9, 8, 23, 59), THREE);
  assert.equal(slots.length, THREE.length);
  assert.deepEqual(slots.map(hm), ["8 10:00", "8 13:00", "8 17:00"]);
});

test("morning before the first slot: the next one is today at 10:00, nothing to catch up", () => {
  const now = at(2026, 9, 8, 9, 0);
  assert.equal(hm(nextSlot(now, THREE)), "8 10:00");
  assert.equal(missedSlot(now, null, THREE), null);
  assert.equal(missedSlot(now, at(2026, 9, 7, 17, 2), THREE), null);
});

test("between slots: there was a run at 10:05 — we wait for 13:00, nothing to catch up", () => {
  const now = at(2026, 9, 8, 11, 30);
  assert.equal(hm(nextSlot(now, THREE)), "8 13:00");
  assert.equal(missedSlot(now, at(2026, 9, 8, 10, 5), THREE), null);
  // Без единого обхода в базе — берём последний прошедший слот сегодня.
  assert.equal(hm(missedSlot(now, null, THREE)), "8 10:00");
});

test("after all the slots: the next one is tomorrow at 10:00", () => {
  const now = at(2026, 9, 8, 20, 0);
  assert.equal(hm(nextSlot(now, THREE)), "9 10:00");
  assert.equal(missedSlot(now, at(2026, 9, 8, 17, 3), THREE), null);
  assert.equal(hm(missedSlot(now, null, THREE)), "8 17:00");
});

test("the computer slept through two slots — we catch up only the later one", () => {
  const now = at(2026, 9, 8, 18, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 8, 10, 2), THREE)), "8 17:00");
});

test("sleep across a day: the last run was yesterday at 17:05, we came back today at 14:00", () => {
  const now = at(2026, 9, 8, 14, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 7, 17, 5), THREE)), "8 13:00");
});

test("midnight: after 17:00 yesterday and before 10:00 today there is nothing to catch up", () => {
  const now = at(2026, 9, 9, 0, 30);
  assert.equal(missedSlot(now, at(2026, 9, 8, 17, 5), THREE), null);
  assert.equal(missedSlot(now, null, THREE), null);
  assert.equal(hm(nextSlot(now, THREE)), "9 10:00");
});

test("an ISO string instead of a Date and garbage instead of a date do not break the calculation", () => {
  const now = at(2026, 9, 8, 18, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 8, 10, 2).toISOString(), THREE)), "8 17:00");
  assert.equal(hm(missedSlot(now, "not a date", THREE)), "8 17:00"); // как будто обходов не было
});

// ------------------------------------------------------------------ пропуск слота
// Владелец, 2026-09-09: сегодня уже обошли всех — слот не запускается.
const finished = (date, scope = "all") => ({ scope, finished_at: date.toISOString() });

test("there was already a finished run over everyone today — the slot is skipped", () => {
  const now = at(2026, 9, 9, 13, 0);
  const covered = slotAlreadyCovered(now, [finished(at(2026, 9, 9, 11, 42))]);
  assert.equal(hm(covered), "9 11:42");
});

test("a run over one creator or over the failed ones does not close the slot", () => {
  const now = at(2026, 9, 9, 13, 0);
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 9, 11, 0), "failed")]), null);
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 9, 11, 0), "6f0d-uuid")]), null);
});

test("an unfinished run and yesterday's one do not close the slot", () => {
  const now = at(2026, 9, 9, 13, 0);
  assert.equal(slotAlreadyCovered(now, [{ scope: "all", finished_at: null }]), null);
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 8, 17, 0))]), null, "yesterday's is not today");
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 9, 20, 0))]), null, "an end later than \"now\" — from the future");
  assert.equal(slotAlreadyCovered(now, []), null);
  assert.equal(slotAlreadyCovered(now, undefined), null);
});

test("a failed run over everyone closes the slot too: a failure has its retry an hour later", () => {
  const now = at(2026, 9, 9, 13, 0);
  const runs = [{ scope: "all", finished_at: at(2026, 9, 9, 10, 30).toISOString(), ok: false }];
  assert.equal(hm(slotAlreadyCovered(now, runs)), "9 10:30");
});

test("out of several runs today the last one is taken", () => {
  const now = at(2026, 9, 9, 13, 0);
  const runs = [finished(at(2026, 9, 9, 9, 5)), finished(at(2026, 9, 9, 12, 20)), finished(at(2026, 9, 8, 23, 0))];
  assert.equal(hm(slotAlreadyCovered(now, runs)), "9 12:20");
});

// ------------------------------------------------------------------ повтор ручной просьбы
test("address throttling is visible in the error text; other failures do not ask for a retry", () => {
  const failures = [
    { handle: "toplombard_warszaw", error: "TikTok returned no list (address throttling; profile says 214 videos): @toplombard_warszaw" },
    { handle: "demo_tiktok", error: "profile not found: @demo_tiktok" },
    { handle: "khaby.lame", error: "TikTok stop screen at @khaby.lame" },
  ];
  assert.deepEqual(addressProtectionHandles(failures), ["toplombard_warszaw"]);
  assert.deepEqual(addressProtectionHandles([]), []);
  assert.deepEqual(addressProtectionHandles(undefined), []);
});

test("one creator does not get into the retry list twice", () => {
  const failures = [
    { handle: "a", error: "address throttling" },
    { handle: "a", error: "address throttling" },
  ];
  assert.deepEqual(addressProtectionHandles(failures), ["a"]);
});

test("the moment of the manual request retry is \"now\" plus minutes, garbage gives 25", () => {
  const now = at(2026, 9, 9, 14, 0);
  assert.equal(hm(manualRetryAt(now, 25)), "9 14:25");
  assert.equal(hm(manualRetryAt(now, 5)), "9 14:05");
  assert.equal(hm(manualRetryAt(now, 0)), "9 14:25", "zero minutes means there is no setting");
  assert.equal(hm(manualRetryAt(now, NaN)), "9 14:25");
});

test("the first run of the day is \"now\" plus minutes; zero means at once, garbage gives 5", () => {
  const now = at(2026, 9, 10, 9, 0);
  assert.equal(hm(firstRunAt(now, 5)), "10 9:05");
  assert.equal(hm(firstRunAt(now, 0)), "10 9:00", "zero means the run starts at once, that is a lawful value");
  assert.equal(hm(firstRunAt(now, NaN)), "10 9:05");
  assert.equal(hm(firstRunAt(now, -3)), "10 9:05", "a negative one is the same garbage");
  assert.equal(hm(firstRunAt(now)), "10 9:05");
});

test("the retry is cancelled if those creators no longer have an error", () => {
  const handles = ["toplombard_warszaw"];
  assert.equal(retryStillNeeded([{ handle: "toplombard_warszaw", sync_error: "TikTok returned no list" }], handles), true);
  assert.equal(retryStillNeeded([{ handle: "toplombard_warszaw", sync_error: null }], handles), false);
  assert.equal(retryStillNeeded([{ handle: "someone_else", sync_error: "trouble" }], handles), false, "this retry does not fix other people's errors");
  assert.equal(retryStillNeeded([], handles), false);
  assert.equal(retryStillNeeded([{ handle: "@toplombard_warszaw", sync_error: "trouble" }], handles), true, "\"@\" and letter case do not get in the way");
  assert.equal(retryStillNeeded([{ handle: "a", sync_error: "trouble" }], []), false, "there is nobody to retry");
});

// ------------------------------------------------------------------ повтор через час
// Строки sync_runs приходят из базы в ISO — в тестах так же, чтобы проверить и разбор.
const run = (started, finished, ok) => ({
  started_at: started.toISOString(),
  finished_at: finished ? finished.toISOString() : null,
  ok,
});
const HOUR = 60 * 60_000;

test("the scheduled run succeeded — there is nothing to retry", () => {
  const now = at(2026, 9, 8, 13, 20);
  const ok = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), true);
  assert.equal(retryDue(now, ok, null, HOUR), null);
  // Обход ещё идёт (ok = null) — тоже не повод.
  assert.equal(retryDue(now, run(at(2026, 9, 8, 13, 0), null, null), null, HOUR), null);
  // Обходов не было вовсе.
  assert.equal(retryDue(now, null, null, HOUR), null);
});

test("the scheduled run failed and there has been no retry yet — an hour after the end", () => {
  const now = at(2026, 9, 8, 13, 20);
  const bad = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), false);
  assert.equal(hm(retryDue(now, bad, null, HOUR)), "8 14:12");
});

test("a retry after this failure has already happened — there will be no second one", () => {
  const now = at(2026, 9, 8, 15, 0);
  const bad = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), false);
  const retry = run(at(2026, 9, 8, 14, 12), at(2026, 9, 8, 14, 25), false);
  assert.equal(retryDue(now, bad, retry, HOUR), null);
  // А повтор от прошлой неудачи (начат раньше конца этой) не считается — повтор всё ещё должен быть.
  const oldRetry = run(at(2026, 9, 8, 11, 5), at(2026, 9, 8, 11, 20), false);
  assert.equal(hm(retryDue(now, bad, oldRetry, HOUR)), "8 14:12");
});

test("the resident started two hours after the failure — the retry moment is in the past, retry at once", () => {
  const now = at(2026, 9, 8, 15, 12);
  const bad = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), false);
  const due = retryDue(now, bad, null, HOUR);
  assert.equal(hm(due), "8 14:12");
  assert.ok(due < now, "the retry moment has already passed");
});

test("an interrupted run without finished_at: we count from the start instead of losing the retry", () => {
  const now = at(2026, 9, 8, 15, 0);
  const bad = run(at(2026, 9, 8, 13, 0), null, false);
  assert.equal(hm(retryDue(now, bad, null, HOUR)), "8 14:00");
});

test("a failure older than a day is not restored — there have been slots of their own since then", () => {
  const bad = run(at(2026, 9, 1, 13, 0), at(2026, 9, 1, 13, 12), false);
  assert.equal(retryDue(at(2026, 9, 8, 9, 0), bad, null, HOUR), null);
  // Ровно на границе суток ещё восстанавливаем: компьютер мог проспать почти день.
  assert.equal(hm(retryDue(at(2026, 9, 2, 13, 0), bad, null, HOUR)), "1 14:12");
});

// --- Свежесть обхода для слота (владелец, 2026-09-10) ---

test("slot: a run four hours ago is not fresh, the slot will go", () => {
  const now = new Date("2026-09-10T17:00:00+03:00");
  const runs = [{ scope: "all", finished_at: "2026-09-10T13:00:00+03:00" }];
  assert.equal(coveredRecently(now, runs, 3 * 3_600_000), null);
});

test("slot: a run two hours ago is fresh, the slot is skipped", () => {
  const now = new Date("2026-09-10T17:00:00+03:00");
  const runs = [{ scope: "all", finished_at: "2026-09-10T15:00:00+03:00" }];
  const c = coveredRecently(now, runs, 3 * 3_600_000);
  assert.ok(c instanceof Date);
});

test("slot: a run over one creator does not give freshness", () => {
  const now = new Date("2026-09-10T17:00:00+03:00");
  const runs = [{ scope: "c1", finished_at: "2026-09-10T16:30:00+03:00" }];
  assert.equal(coveredRecently(now, runs, 3 * 3_600_000), null);
});

test("slot: an unfinished run does not give freshness", () => {
  const now = new Date("2026-09-10T17:00:00+03:00");
  assert.equal(coveredRecently(now, [{ scope: "all", finished_at: null }], 3 * 3_600_000), null);
});

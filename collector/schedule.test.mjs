// Тесты расписания: `npm test` в collector.
// Даты берутся местные (new Date(год, месяц, день, час)) — слоты тоже местные.

import { test } from "node:test";
import assert from "node:assert/strict";
import { slotsOf, nextSlot, missedSlot, retryDue, SLOT_HOURS } from "./schedule.mjs";

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const hm = (date) => (date === null ? null : `${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`);

test("слоты дня — 10:00, 13:00, 17:00 того же дня", () => {
  const slots = slotsOf(at(2026, 9, 8, 23, 59));
  assert.equal(slots.length, SLOT_HOURS.length);
  assert.deepEqual(slots.map(hm), ["8 10:00", "8 13:00", "8 17:00"]);
});

test("утро до первого слота: ближайший — сегодня 10:00, догонять нечего", () => {
  const now = at(2026, 9, 8, 9, 0);
  assert.equal(hm(nextSlot(now)), "8 10:00");
  assert.equal(missedSlot(now, null), null);
  assert.equal(missedSlot(now, at(2026, 9, 7, 17, 2)), null);
});

test("между слотами: обход в 10:05 был — ждём 13:00, догонять нечего", () => {
  const now = at(2026, 9, 8, 11, 30);
  assert.equal(hm(nextSlot(now)), "8 13:00");
  assert.equal(missedSlot(now, at(2026, 9, 8, 10, 5)), null);
  // Без единого обхода в базе — берём последний прошедший слот сегодня.
  assert.equal(hm(missedSlot(now, null)), "8 10:00");
});

test("после всех слотов: следующий — завтра 10:00", () => {
  const now = at(2026, 9, 8, 20, 0);
  assert.equal(hm(nextSlot(now)), "9 10:00");
  assert.equal(missedSlot(now, at(2026, 9, 8, 17, 3)), null);
  assert.equal(hm(missedSlot(now, null)), "8 17:00");
});

test("компьютер спал через два слота — догоняем только поздний", () => {
  const now = at(2026, 9, 8, 18, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 8, 10, 2))), "8 17:00");
});

test("сон через сутки: последний обход вчера в 17:05, включились сегодня в 14:00", () => {
  const now = at(2026, 9, 8, 14, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 7, 17, 5))), "8 13:00");
});

test("полночь: после 17:00 вчера и до 10:00 сегодня догонять нечего", () => {
  const now = at(2026, 9, 9, 0, 30);
  assert.equal(missedSlot(now, at(2026, 9, 8, 17, 5)), null);
  assert.equal(missedSlot(now, null), null);
  assert.equal(hm(nextSlot(now)), "9 10:00");
});

test("строка ISO вместо Date и мусор вместо даты не ломают расчёт", () => {
  const now = at(2026, 9, 8, 18, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 8, 10, 2).toISOString())), "8 17:00");
  assert.equal(hm(missedSlot(now, "не дата")), "8 17:00"); // как будто обходов не было
});

// ------------------------------------------------------------------ повтор через час
// Строки sync_runs приходят из базы в ISO — в тестах так же, чтобы проверить и разбор.
const run = (started, finished, ok) => ({
  started_at: started.toISOString(),
  finished_at: finished ? finished.toISOString() : null,
  ok,
});
const HOUR = 60 * 60_000;

test("обход по расписанию удался — повторять нечего", () => {
  const now = at(2026, 9, 8, 13, 20);
  const ok = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), true);
  assert.equal(retryDue(now, ok, null, HOUR), null);
  // Обход ещё идёт (ok = null) — тоже не повод.
  assert.equal(retryDue(now, run(at(2026, 9, 8, 13, 0), null, null), null, HOUR), null);
  // Обходов не было вовсе.
  assert.equal(retryDue(now, null, null, HOUR), null);
});

test("обход по расписанию не удался, повтора ещё не было — через час после конца", () => {
  const now = at(2026, 9, 8, 13, 20);
  const bad = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), false);
  assert.equal(hm(retryDue(now, bad, null, HOUR)), "8 14:12");
});

test("повтор после этой неудачи уже был — второго не будет", () => {
  const now = at(2026, 9, 8, 15, 0);
  const bad = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), false);
  const retry = run(at(2026, 9, 8, 14, 12), at(2026, 9, 8, 14, 25), false);
  assert.equal(retryDue(now, bad, retry, HOUR), null);
  // А повтор от прошлой неудачи (начат раньше конца этой) не считается — повтор всё ещё должен быть.
  const oldRetry = run(at(2026, 9, 8, 11, 5), at(2026, 9, 8, 11, 20), false);
  assert.equal(hm(retryDue(now, bad, oldRetry, HOUR)), "8 14:12");
});

test("резидент поднялся через два часа после неудачи — момент повтора в прошлом, повторять сразу", () => {
  const now = at(2026, 9, 8, 15, 12);
  const bad = run(at(2026, 9, 8, 13, 0), at(2026, 9, 8, 13, 12), false);
  const due = retryDue(now, bad, null, HOUR);
  assert.equal(hm(due), "8 14:12");
  assert.ok(due < now, "момент повтора уже прошёл");
});

test("оборванный обход без finished_at: считаем от начала, а не теряем повтор", () => {
  const now = at(2026, 9, 8, 15, 0);
  const bad = run(at(2026, 9, 8, 13, 0), null, false);
  assert.equal(hm(retryDue(now, bad, null, HOUR)), "8 14:00");
});

test("неудача старше суток не восстанавливается — с тех пор были свои слоты", () => {
  const bad = run(at(2026, 9, 1, 13, 0), at(2026, 9, 1, 13, 12), false);
  assert.equal(retryDue(at(2026, 9, 8, 9, 0), bad, null, HOUR), null);
  // Ровно на границе суток ещё восстанавливаем: компьютер мог проспать почти день.
  assert.equal(hm(retryDue(at(2026, 9, 2, 13, 0), bad, null, HOUR)), "1 14:12");
});

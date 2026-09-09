// Тесты расписания: `npm test` в collector.
// Даты берутся местные (new Date(год, месяц, день, час)) — слоты тоже местные.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slotsOf, nextSlot, missedSlot, retryDue, SLOT_HOURS, DEFAULT_SLOTS, parseSlots,
  slotAlreadyCovered, addressProtectionHandles, manualRetryAt, retryStillNeeded,
} from "./schedule.mjs";

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const hm = (date) => (date === null ? null : `${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`);
// Прежнее расписание: часы теперь приходят параметром из `AMESTAT_SLOTS`, а не константой.
const THREE = [10, 13, 17];

// ------------------------------------------------------------------ часы из настроек
test("по умолчанию слот один — 13:00", () => {
  assert.deepEqual(DEFAULT_SLOTS, [13]);
  assert.deepEqual(SLOT_HOURS, [13]);
  assert.deepEqual(slotsOf(at(2026, 9, 8, 23, 59)).map(hm), ["8 13:00"]);
});

test("AMESTAT_SLOTS: один час, список, мусор и пустота", () => {
  assert.deepEqual(parseSlots("13"), [13]);
  assert.deepEqual(parseSlots("10,13,17"), [10, 13, 17]);
  assert.deepEqual(parseSlots(" 17 , 10 "), [10, 17], "порядок по возрастанию, пробелы не мешают");
  assert.deepEqual(parseSlots("13,13"), [13], "дубли убираются");
  assert.deepEqual(parseSlots(""), [13]);
  assert.deepEqual(parseSlots(undefined), [13]);
  assert.deepEqual(parseSlots("вечером"), [13], "мусор — значит расписание по умолчанию");
  assert.deepEqual(parseSlots("25,-1,9.5"), [13], "часов вне суток и дробных не бывает");
  assert.deepEqual(parseSlots("0"), [0], "полночь — законный час, а не пустота");
});

test("один слот 13:00: ближайший, догон и полночь", () => {
  assert.equal(hm(nextSlot(at(2026, 9, 8, 9, 0))), "8 13:00");
  assert.equal(hm(nextSlot(at(2026, 9, 8, 14, 0))), "9 13:00", "после слота — завтрашний");
  assert.equal(missedSlot(at(2026, 9, 8, 9, 0), null), null, "до слота догонять нечего");
  assert.equal(hm(missedSlot(at(2026, 9, 8, 20, 0), null)), "8 13:00");
  assert.equal(missedSlot(at(2026, 9, 8, 20, 0), at(2026, 9, 8, 13, 2)), null, "слот отработан");
});

test("слоты дня — 10:00, 13:00, 17:00 того же дня", () => {
  const slots = slotsOf(at(2026, 9, 8, 23, 59), THREE);
  assert.equal(slots.length, THREE.length);
  assert.deepEqual(slots.map(hm), ["8 10:00", "8 13:00", "8 17:00"]);
});

test("утро до первого слота: ближайший — сегодня 10:00, догонять нечего", () => {
  const now = at(2026, 9, 8, 9, 0);
  assert.equal(hm(nextSlot(now, THREE)), "8 10:00");
  assert.equal(missedSlot(now, null, THREE), null);
  assert.equal(missedSlot(now, at(2026, 9, 7, 17, 2), THREE), null);
});

test("между слотами: обход в 10:05 был — ждём 13:00, догонять нечего", () => {
  const now = at(2026, 9, 8, 11, 30);
  assert.equal(hm(nextSlot(now, THREE)), "8 13:00");
  assert.equal(missedSlot(now, at(2026, 9, 8, 10, 5), THREE), null);
  // Без единого обхода в базе — берём последний прошедший слот сегодня.
  assert.equal(hm(missedSlot(now, null, THREE)), "8 10:00");
});

test("после всех слотов: следующий — завтра 10:00", () => {
  const now = at(2026, 9, 8, 20, 0);
  assert.equal(hm(nextSlot(now, THREE)), "9 10:00");
  assert.equal(missedSlot(now, at(2026, 9, 8, 17, 3), THREE), null);
  assert.equal(hm(missedSlot(now, null, THREE)), "8 17:00");
});

test("компьютер спал через два слота — догоняем только поздний", () => {
  const now = at(2026, 9, 8, 18, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 8, 10, 2), THREE)), "8 17:00");
});

test("сон через сутки: последний обход вчера в 17:05, включились сегодня в 14:00", () => {
  const now = at(2026, 9, 8, 14, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 7, 17, 5), THREE)), "8 13:00");
});

test("полночь: после 17:00 вчера и до 10:00 сегодня догонять нечего", () => {
  const now = at(2026, 9, 9, 0, 30);
  assert.equal(missedSlot(now, at(2026, 9, 8, 17, 5), THREE), null);
  assert.equal(missedSlot(now, null, THREE), null);
  assert.equal(hm(nextSlot(now, THREE)), "9 10:00");
});

test("строка ISO вместо Date и мусор вместо даты не ломают расчёт", () => {
  const now = at(2026, 9, 8, 18, 0);
  assert.equal(hm(missedSlot(now, at(2026, 9, 8, 10, 2).toISOString(), THREE)), "8 17:00");
  assert.equal(hm(missedSlot(now, "не дата", THREE)), "8 17:00"); // как будто обходов не было
});

// ------------------------------------------------------------------ пропуск слота
// Владелец, 2026-09-09: сегодня уже обошли всех — слот не запускается.
const finished = (date, scope = "all") => ({ scope, finished_at: date.toISOString() });

test("сегодня уже был завершённый обход по всем — слот пропускается", () => {
  const now = at(2026, 9, 9, 13, 0);
  const covered = slotAlreadyCovered(now, [finished(at(2026, 9, 9, 11, 42))]);
  assert.equal(hm(covered), "9 11:42");
});

test("обход по одному креатору или по неудавшимся слот не закрывает", () => {
  const now = at(2026, 9, 9, 13, 0);
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 9, 11, 0), "failed")]), null);
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 9, 11, 0), "6f0d-uuid")]), null);
});

test("незаконченный обход и вчерашний слот не закрывают", () => {
  const now = at(2026, 9, 9, 13, 0);
  assert.equal(slotAlreadyCovered(now, [{ scope: "all", finished_at: null }]), null);
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 8, 17, 0))]), null, "вчерашний — не сегодня");
  assert.equal(slotAlreadyCovered(now, [finished(at(2026, 9, 9, 20, 0))]), null, "конец позже «сейчас» — из будущего");
  assert.equal(slotAlreadyCovered(now, []), null);
  assert.equal(slotAlreadyCovered(now, undefined), null);
});

test("неудачный обход по всем слот тоже закрывает: на неудачу есть повтор через час", () => {
  const now = at(2026, 9, 9, 13, 0);
  const runs = [{ scope: "all", finished_at: at(2026, 9, 9, 10, 30).toISOString(), ok: false }];
  assert.equal(hm(slotAlreadyCovered(now, runs)), "9 10:30");
});

test("из нескольких сегодняшних обходов берётся последний", () => {
  const now = at(2026, 9, 9, 13, 0);
  const runs = [finished(at(2026, 9, 9, 9, 5)), finished(at(2026, 9, 9, 12, 20)), finished(at(2026, 9, 8, 23, 0))];
  assert.equal(hm(slotAlreadyCovered(now, runs)), "9 12:20");
});

// ------------------------------------------------------------------ повтор ручной просьбы
test("защиту по адресу видно по тексту ошибки; остальные неудачи повтора не просят", () => {
  const failures = [
    { handle: "toplombard_warszaw", error: "TikTok не отдал список (защита по адресу; по профилю 214 видео): @toplombard_warszaw" },
    { handle: "demo_tiktok", error: "профиль не найден: @demo_tiktok" },
    { handle: "khaby.lame", error: "стоп-экран TikTok у @khaby.lame" },
  ];
  assert.deepEqual(addressProtectionHandles(failures), ["toplombard_warszaw"]);
  assert.deepEqual(addressProtectionHandles([]), []);
  assert.deepEqual(addressProtectionHandles(undefined), []);
});

test("один креатор не попадает в список повтора дважды", () => {
  const failures = [
    { handle: "a", error: "защита по адресу" },
    { handle: "a", error: "защита по адресу" },
  ];
  assert.deepEqual(addressProtectionHandles(failures), ["a"]);
});

test("момент повтора ручной просьбы — «сейчас» плюс минуты, мусор даёт 25", () => {
  const now = at(2026, 9, 9, 14, 0);
  assert.equal(hm(manualRetryAt(now, 25)), "9 14:25");
  assert.equal(hm(manualRetryAt(now, 5)), "9 14:05");
  assert.equal(hm(manualRetryAt(now, 0)), "9 14:25", "ноль минут — значит настройки нет");
  assert.equal(hm(manualRetryAt(now, NaN)), "9 14:25");
});

test("повтор отменяется, если по тем креаторам ошибки уже нет", () => {
  const handles = ["toplombard_warszaw"];
  assert.equal(retryStillNeeded([{ handle: "toplombard_warszaw", sync_error: "TikTok не отдал список" }], handles), true);
  assert.equal(retryStillNeeded([{ handle: "toplombard_warszaw", sync_error: null }], handles), false);
  assert.equal(retryStillNeeded([{ handle: "someone_else", sync_error: "беда" }], handles), false, "чужие ошибки этот повтор не чинит");
  assert.equal(retryStillNeeded([], handles), false);
  assert.equal(retryStillNeeded([{ handle: "@toplombard_warszaw", sync_error: "беда" }], handles), true, "«@» и регистр не мешают");
  assert.equal(retryStillNeeded([{ handle: "a", sync_error: "беда" }], []), false, "некого повторять");
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

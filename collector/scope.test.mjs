// Охват видео «всё» / «только наши» (владелец, 2026-09-09; миграция v17).
//
// Браузера здесь нет вовсе — это правила прокрутки и отбора, и проверяются они на выдуманных
// списках: докуда листать, что считается ненайденным и что переживает границу недели.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listStop, listRounds, missingTracked, filterDepth } from "./scope.mjs";

// --- охват «всё»: правило прежнее ----------------------------------------------------------

test("охват «всё»: листаем, пока список не кончился", () => {
  assert.deepEqual(listStop({ mode: "all", hasMore: true }), { stop: false, reason: null });
  assert.deepEqual(listStop({ mode: "all", hasMore: false }), { stop: true, reason: "end" });
});

test("охват «всё»: видео старше недели обрывают прокрутку", () => {
  assert.deepEqual(listStop({ mode: "all", hasMore: true, reachedOld: true }), { stop: true, reason: "old" });
});

test("охват не указан вовсе — считается «всё»", () => {
  assert.equal(listStop({ hasMore: true }).stop, false);
  assert.equal(listStop().stop, false);
});

// --- охват «только наши» -------------------------------------------------------------------

test("листаем, пока не встретились все отслеживаемые", () => {
  const trackedIds = ["a", "b", "c"];
  assert.deepEqual(listStop({ mode: "ours", trackedIds, seenIds: ["a"], hasMore: true }), { stop: false, reason: null });
  assert.deepEqual(listStop({ mode: "ours", trackedIds, seenIds: ["c", "b", "a", "x"], hasMore: true }), { stop: true, reason: "tracked" });
});

test("список кончился раньше — останавливаемся, даже если нашлись не все", () => {
  assert.deepEqual(
    listStop({ mode: "ours", trackedIds: ["a", "b"], seenIds: ["a"], hasMore: false }),
    { stop: true, reason: "end" },
  );
});

test("отслеживаемых нет вовсе — хватает первой страницы", () => {
  assert.deepEqual(listStop({ mode: "ours", trackedIds: [], seenIds: ["x"], hasMore: true }), { stop: true, reason: "no-tracked" });
});

test("глубина «неделя» при «только наши» прокрутку НЕ обрывает — иначе старые наши не обновятся", () => {
  const step = listStop({ mode: "ours", trackedIds: ["a", "b"], seenIds: ["a"], reachedOld: true, hasMore: true });
  assert.deepEqual(step, { stop: false, reason: null });
});

test("id сравниваются как строки: число из ленты и строка из базы — одно и то же видео", () => {
  assert.deepEqual(listStop({ mode: "ours", trackedIds: ["17900"], seenIds: [17900], hasMore: true }).reason, "tracked");
});

// --- кого не нашли -------------------------------------------------------------------------

test("ненайденные отслеживаемые перечисляются поимённо", () => {
  assert.deepEqual(missingTracked(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(missingTracked(["a"], ["a"]), []);
  assert.deepEqual(missingTracked([], ["a"]), []);
  assert.deepEqual(missingTracked(undefined, undefined), []);
});

// --- потолок прокруток ---------------------------------------------------------------------

test("у «только наши» свой потолок прокруток, у «всё» — прежний", () => {
  assert.equal(listRounds("ours", 30, 80), 30);
  assert.equal(listRounds("all", 30, 80), 80);
  assert.equal(listRounds("ours", "", 80), 80, "пусто — берём потолок площадки");
  assert.equal(listRounds("ours", 0, 80), 80, "мусор не должен обнулять прокрутку");
  assert.equal(listRounds("ours", "12", 80), 12);
});

// --- отбор по глубине ----------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-09T12:00:00Z");
const SINCE = NOW - 7 * DAY;
const v = (id, daysAgo) => ({ id, publishedAt: new Date(NOW - daysAgo * DAY).toISOString() });

test("глубина «всё» — берём всё, что пришло", () => {
  const all = [v("a", 1), v("b", 100)];
  assert.deepEqual(filterDepth(all, null).map((x) => x.id), ["a", "b"]);
});

test("глубина «неделя» отсекает старое, как и раньше", () => {
  const all = [v("fresh", 2), v("old", 30), { id: "nodate", publishedAt: null }];
  assert.deepEqual(filterDepth(all, SINCE).map((x) => x.id), ["fresh"]);
});

test("отслеживаемое видео неделя не отсекает — ради него и листали глубже", () => {
  const all = [v("fresh", 2), v("ourOld", 30), v("alienOld", 30)];
  assert.deepEqual(filterDepth(all, SINCE, ["ourOld"]).map((x) => x.id), ["fresh", "ourOld"]);
});

test("отслеживаемое без даты тоже остаётся", () => {
  const all = [{ id: "ourNoDate", publishedAt: null }];
  assert.deepEqual(filterDepth(all, SINCE, ["ourNoDate"]).map((x) => x.id), ["ourNoDate"]);
  assert.deepEqual(filterDepth(all, SINCE, []).map((x) => x.id), []);
});

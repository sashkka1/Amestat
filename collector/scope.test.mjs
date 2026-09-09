// Охват видео «всё» / «только наши» (владелец, 2026-09-09; миграция v17).
//
// Браузера здесь нет вовсе — это правила прокрутки и отбора, и проверяются они на выдуманных
// списках: докуда листать, что считается ненайденным и что переживает границу недели.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listStop, listRounds, missingTracked, filterDepth,
  depthBounds, depthWord, depthLabel, normalizeDepth, dayRange,
  videoCap, widerCap,
  WEEK_MS, MONTH_MS,
} from "./scope.mjs";

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

// --- границы глубины: all / week / month / range (миграция v18) -----------------------------

test("глубина «всё» — границ нет вовсе", () => {
  assert.deepEqual(depthBounds("all", {}, NOW), { since: null, until: null });
  assert.deepEqual(depthBounds(undefined, {}, NOW), { since: null, until: null });
  assert.deepEqual(depthBounds("ЧЕПУХА", {}, NOW), { since: null, until: null });
});

test("«неделя» — 7 дней назад, «месяц» — 30; верхней границы у обеих нет", () => {
  assert.deepEqual(depthBounds("week", {}, NOW), { since: NOW - WEEK_MS, until: null });
  assert.deepEqual(depthBounds("month", {}, NOW), { since: NOW - MONTH_MS, until: null });
  assert.equal(MONTH_MS, 30 * DAY);
});

test("«период» берёт края как есть — и разворачивает перепутанные местами", () => {
  const from = "2026-09-01T00:00:00.000Z", to = "2026-09-09T23:59:59.999Z";
  assert.deepEqual(depthBounds("range", { from, to }, NOW), { since: Date.parse(from), until: Date.parse(to) });
  assert.deepEqual(depthBounds("range", { from: to, to: from }, NOW), { since: Date.parse(from), until: Date.parse(to) });
});

test("«период» без разбираемых краёв отдаёт нули, а не пустоту", () => {
  assert.deepEqual(depthBounds("range", { from: null, to: null }, NOW), { since: null, until: null });
  assert.deepEqual(depthBounds("range", { from: "не дата", to: "тоже" }, NOW), { since: null, until: null });
});

test("края понимаются и как Date, и как число мс", () => {
  const a = new Date(NOW - 20 * DAY), b = new Date(NOW - 10 * DAY);
  assert.deepEqual(depthBounds("range", { from: a, to: b }, NOW), { since: a.getTime(), until: b.getTime() });
  assert.deepEqual(depthBounds("range", { from: a.getTime(), to: b.getTime() }, NOW), { since: a.getTime(), until: b.getTime() });
});

// --- верхняя граница в отборе ---------------------------------------------------------------

test("видео свежее верхней границы не берётся, но и прокрутку не трогает", () => {
  const all = [v("today", 0), v("inRange", 15), v("tooOld", 40)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  assert.deepEqual(filterDepth(all, since, [], until).map((x) => x.id), ["inRange"]);
});

test("🔴 верхнюю границу не переживает даже отслеживаемое: период есть период", () => {
  const all = [v("ourFresh", 1), v("ourInRange", 15)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  assert.deepEqual(
    filterDepth(all, since, ["ourFresh", "ourInRange"], until).map((x) => x.id),
    ["ourInRange"],
    "наше вчерашнее видео в срез за прошлый месяц не идёт",
  );
});

test("нижнюю границу отслеживаемое переживает и при заданной верхней", () => {
  const all = [v("ourAncient", 300), v("alienAncient", 300)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  assert.deepEqual(filterDepth(all, since, ["ourAncient"], until).map((x) => x.id), ["ourAncient"]);
});

test("видео без даты в период не берётся вовсе — даже отслеживаемое", () => {
  const all = [{ id: "noDate", publishedAt: null }];
  assert.deepEqual(filterDepth(all, NOW - 20 * DAY, ["noDate"], NOW - 10 * DAY).map((x) => x.id), []);
});

test("границ нет вовсе — список отдаётся как есть", () => {
  const all = [v("a", 1), v("b", 900)];
  assert.deepEqual(filterDepth(all, null, [], null).map((x) => x.id), ["a", "b"]);
});

// --- потолок числа видео (миграция v19) -------------------------------------------------------

test("потолок обрывает прокрутку, как только набрано столько видео в пределах глубины", () => {
  assert.deepEqual(listStop({ mode: "all", hasMore: true, maxVideos: 50, inDepth: 49 }), { stop: false, reason: null });
  assert.deepEqual(listStop({ mode: "all", hasMore: true, maxVideos: 50, inDepth: 50 }), { stop: true, reason: "max" });
  assert.deepEqual(listStop({ mode: "all", hasMore: true, maxVideos: null, inDepth: 900 }), { stop: false, reason: null }, "без потолка листаем как раньше");
});

test("при охвате «только наши» потолок прокрутку не обрывает — отслеживаемых он не режет", () => {
  const step = listStop({ mode: "ours", trackedIds: ["a", "b"], seenIds: ["a"], hasMore: true, maxVideos: 1, inDepth: 99 });
  assert.deepEqual(step, { stop: false, reason: null });
});

test("в базу идут только первые maxVideos самых новых — порядок списка не меняется", () => {
  const all = [v("new", 1), v("old", 5), v("mid", 3)];
  assert.deepEqual(filterDepth(all, null, [], null, 2).map((x) => x.id), ["new", "mid"], "самое старое отсечено, порядок прежний");
  assert.deepEqual(filterDepth(all, null, [], null, 9).map((x) => x.id), ["new", "old", "mid"], "потолок выше числа видео — не режет");
  assert.deepEqual(filterDepth([v("a", 1), { id: "nodate", publishedAt: null }], null, [], null, 1).map((x) => x.id), ["a"], "без даты считается самым старым");
});

test("отслеживаемое видео потолок переживает, даже если оно не в самых новых", () => {
  const all = [v("new", 1), v("mid", 3), v("ourOld", 300)];
  assert.deepEqual(filterDepth(all, SINCE, ["ourOld"], null, 1).map((x) => x.id), ["new", "ourOld"]);
});

test("потолок приводится к одному виду, а склейка берёт пошире (null побеждает)", () => {
  assert.equal(videoCap("50"), 50);
  assert.equal(videoCap(null), null);
  assert.equal(videoCap(0), null, "ноль — это «без потолка», а не «ноль видео»");
  assert.equal(videoCap("чепуха"), null);
  assert.equal(widerCap(20, 50), 50);
  assert.equal(widerCap(20, null), null);
  assert.equal(widerCap(null, null), null);
});

// --- приведение глубины ---------------------------------------------------------------------

test("знакомые глубины проходят как есть, границы только у периода", () => {
  assert.deepEqual(normalizeDepth("week"), { depth: "week", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth("month"), { depth: "month", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth("MONTH "), { depth: "month", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth("all"), { depth: "all", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth(null), { depth: "all", from: null, to: null, note: null });
});

test("незнакомая глубина опускается до «всё» — и об этом есть что сказать в лог", () => {
  const got = normalizeDepth("год");
  assert.equal(got.depth, "all");
  assert.match(got.note, /неизвестная глубина/);
});

test("«период» без границ (или задом наперёд) опускается до «всё» с замечанием", () => {
  for (const args of [["range", null, null], ["range", "2026-09-01", null], ["range", "2026-09-09", "2026-09-01"], ["range", "2026-09-01", "2026-09-01"]]) {
    const got = normalizeDepth(...args);
    assert.equal(got.depth, "all", `${args[1]}…${args[2]}`);
    assert.match(got.note, /период/);
  }
});

test("«период» с границами остаётся периодом, а края становятся ISO", () => {
  const got = normalizeDepth("range", "2026-09-01T00:00:00Z", new Date(Date.parse("2026-09-09T00:00:00Z")));
  assert.equal(got.depth, "range");
  assert.equal(got.note, null);
  assert.equal(got.from, "2026-09-01T00:00:00.000Z");
  assert.equal(got.to, "2026-09-09T00:00:00.000Z");
});

// --- глубина словом --------------------------------------------------------------------------

test("слово глубины — одно на весь сборщик", () => {
  assert.equal(depthWord("all"), "всё");
  assert.equal(depthWord("week"), "неделя");
  assert.equal(depthWord("month"), "месяц");
  assert.equal(depthWord("range"), "период");
  assert.equal(depthWord("чепуха"), "всё");
});

test("у периода к слову прибавляются края, у прочих глубин — нет", () => {
  const from = new Date(2026, 8, 1, 0, 0, 0, 0);      // местные сутки: так их задаёт человек
  const to = new Date(2026, 8, 9, 23, 59, 59, 999);
  assert.equal(depthLabel("range", from, to), "период 01.09–09.09");
  assert.equal(depthLabel("month"), "месяц");
  assert.equal(depthLabel("all"), "всё");
  assert.equal(depthLabel("range", null, null), "период", "края потерялись — остаётся хотя бы слово");
});

// --- период из командной строки --------------------------------------------------------------

test("даты берутся целыми местными сутками: --to по конец своего дня", () => {
  const got = dayRange("2026-09-01", "2026-09-09");
  assert.equal(Date.parse(got.from), new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
  assert.equal(Date.parse(got.to), new Date(2026, 8, 9, 23, 59, 59, 999).getTime(), "иначе девятое число теряется целиком");
});

test("один день — тоже период", () => {
  const got = dayRange("2026-09-05", "2026-09-05");
  assert.equal(Date.parse(got.to) - Date.parse(got.from), DAY - 1);
});

test("полный момент времени берётся как есть", () => {
  const got = dayRange("2026-09-01T12:00:00Z", "2026-09-02T12:00:00Z");
  assert.equal(got.from, "2026-09-01T12:00:00.000Z");
  assert.equal(got.to, "2026-09-02T12:00:00.000Z");
});

test("мусор и перевёрнутый период — null, а не молчаливая подмена", () => {
  assert.equal(dayRange("", "2026-09-09"), null);
  assert.equal(dayRange("2026-09-09", null), null);
  assert.equal(dayRange("вчера", "сегодня"), null);
  assert.equal(dayRange("2026-09-09", "2026-09-01"), null);
});

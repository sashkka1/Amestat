// Охват видео «всё» / «только наши» (владелец, 2026-09-09; миграция v17).
//
// Браузера здесь нет вовсе — это правила прокрутки и отбора, и проверяются они на выдуманных
// списках: докуда листать, что считается ненайденным и что переживает границу недели.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listStop, listRounds, missingTracked, filterDepth, shortfall, vanishedVideos, returnedGone,
  depthBounds, depthWord, depthLabel, normalizeDepth, dayRange,
  videoCap, widerCap,
  WEEK_MS, MONTH_MS,
} from "./scope.mjs";

// --- охват «всё»: правило прежнее ----------------------------------------------------------

test("scope \"all\": keep scrolling until the list ends", () => {
  assert.deepEqual(listStop({ mode: "all", hasMore: true }), { stop: false, reason: null });
  assert.deepEqual(listStop({ mode: "all", hasMore: false }), { stop: true, reason: "end" });
});

test("scope \"all\": videos older than a week stop the scroll", () => {
  assert.deepEqual(listStop({ mode: "all", hasMore: true, reachedOld: true }), { stop: true, reason: "old" });
});

test("no scope given at all — treated as \"all\"", () => {
  assert.equal(listStop({ hasMore: true }).stop, false);
  assert.equal(listStop().stop, false);
});

// --- охват «только наши» -------------------------------------------------------------------

test("keep scrolling until every tracked video has been seen", () => {
  const trackedIds = ["a", "b", "c"];
  assert.deepEqual(listStop({ mode: "ours", trackedIds, seenIds: ["a"], hasMore: true }), { stop: false, reason: null });
  assert.deepEqual(listStop({ mode: "ours", trackedIds, seenIds: ["c", "b", "a", "x"], hasMore: true }), { stop: true, reason: "tracked" });
});

test("the list ended first — stop even if not all were found", () => {
  assert.deepEqual(
    listStop({ mode: "ours", trackedIds: ["a", "b"], seenIds: ["a"], hasMore: false }),
    { stop: true, reason: "end" },
  );
});

test("no tracked videos at all — the first page is enough", () => {
  assert.deepEqual(listStop({ mode: "ours", trackedIds: [], seenIds: ["x"], hasMore: true }), { stop: true, reason: "no-tracked" });
});

test("depth \"week\" under \"ours only\" does NOT stop the scroll — otherwise old ours never refresh", () => {
  const step = listStop({ mode: "ours", trackedIds: ["a", "b"], seenIds: ["a"], reachedOld: true, hasMore: true });
  assert.deepEqual(step, { stop: false, reason: null });
});

test("ids compare as strings: a number from the feed and a string from the DB are the same video", () => {
  assert.deepEqual(listStop({ mode: "ours", trackedIds: ["17900"], seenIds: [17900], hasMore: true }).reason, "tracked");
});

// --- кого не нашли -------------------------------------------------------------------------

test("tracked videos that were not found are listed by id", () => {
  assert.deepEqual(missingTracked(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(missingTracked(["a"], ["a"]), []);
  assert.deepEqual(missingTracked([], ["a"]), []);
  assert.deepEqual(missingTracked(undefined, undefined), []);
});

// --- потолок прокруток ---------------------------------------------------------------------

test("\"ours only\" has its own scroll cap, \"all\" keeps the platform one", () => {
  assert.equal(listRounds("ours", 30, 80), 30);
  assert.equal(listRounds("all", 30, 80), 80);
  assert.equal(listRounds("ours", "", 80), 80, "empty — fall back to the platform cap");
  assert.equal(listRounds("ours", 0, 80), 80, "garbage must not zero out the scroll");
  assert.equal(listRounds("ours", "12", 80), 12);
});

// --- отбор по глубине ----------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-09T12:00:00Z");
const SINCE = NOW - 7 * DAY;
const v = (id, daysAgo) => ({ id, publishedAt: new Date(NOW - daysAgo * DAY).toISOString() });

test("depth \"all\" — keep everything that came back", () => {
  const all = [v("a", 1), v("b", 100)];
  assert.deepEqual(filterDepth(all, null).map((x) => x.id), ["a", "b"]);
});

test("depth \"week\" cuts off the old ones, as before", () => {
  const all = [v("fresh", 2), v("old", 30), { id: "nodate", publishedAt: null }];
  assert.deepEqual(filterDepth(all, SINCE).map((x) => x.id), ["fresh"]);
});

test("a week does not cut off a tracked video — we scrolled deeper for it", () => {
  const all = [v("fresh", 2), v("ourOld", 30), v("alienOld", 30)];
  assert.deepEqual(filterDepth(all, SINCE, ["ourOld"]).map((x) => x.id), ["fresh", "ourOld"]);
});

test("a tracked video without a date stays too", () => {
  const all = [{ id: "ourNoDate", publishedAt: null }];
  assert.deepEqual(filterDepth(all, SINCE, ["ourNoDate"]).map((x) => x.id), ["ourNoDate"]);
  assert.deepEqual(filterDepth(all, SINCE, []).map((x) => x.id), []);
});

// --- границы глубины: all / week / month / range (миграция v18) -----------------------------

test("depth \"all\" — no bounds at all", () => {
  assert.deepEqual(depthBounds("all", {}, NOW), { since: null, until: null });
  assert.deepEqual(depthBounds(undefined, {}, NOW), { since: null, until: null });
  assert.deepEqual(depthBounds("NONSENSE", {}, NOW), { since: null, until: null });
});

test("\"week\" — 7 days back, \"month\" — 30; neither has an upper bound", () => {
  assert.deepEqual(depthBounds("week", {}, NOW), { since: NOW - WEEK_MS, until: null });
  assert.deepEqual(depthBounds("month", {}, NOW), { since: NOW - MONTH_MS, until: null });
  assert.equal(MONTH_MS, 30 * DAY);
});

test("\"range\" takes the edges as they are — and swaps them back if reversed", () => {
  const from = "2026-09-01T00:00:00.000Z", to = "2026-09-09T23:59:59.999Z";
  assert.deepEqual(depthBounds("range", { from, to }, NOW), { since: Date.parse(from), until: Date.parse(to) });
  assert.deepEqual(depthBounds("range", { from: to, to: from }, NOW), { since: Date.parse(from), until: Date.parse(to) });
});

test("\"range\" with unparsable edges yields nulls, not emptiness", () => {
  assert.deepEqual(depthBounds("range", { from: null, to: null }, NOW), { since: null, until: null });
  assert.deepEqual(depthBounds("range", { from: "not a date", to: "also not" }, NOW), { since: null, until: null });
});

test("edges are understood both as Date and as milliseconds", () => {
  const a = new Date(NOW - 20 * DAY), b = new Date(NOW - 10 * DAY);
  assert.deepEqual(depthBounds("range", { from: a, to: b }, NOW), { since: a.getTime(), until: b.getTime() });
  assert.deepEqual(depthBounds("range", { from: a.getTime(), to: b.getTime() }, NOW), { since: a.getTime(), until: b.getTime() });
});

// --- верхняя граница в отборе ---------------------------------------------------------------

test("a video newer than the upper bound is not taken, but does not stop the scroll", () => {
  const all = [v("today", 0), v("inRange", 15), v("tooOld", 40)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  assert.deepEqual(filterDepth(all, since, [], until).map((x) => x.id), ["inRange"]);
});

test("🔴 not even a tracked video survives the upper bound: a range is a range", () => {
  const all = [v("ourFresh", 1), v("ourInRange", 15)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  assert.deepEqual(
    filterDepth(all, since, ["ourFresh", "ourInRange"], until).map((x) => x.id),
    ["ourInRange"],
    "our yesterday's video does not belong in a slice of last month",
  );
});

test("a tracked video survives the lower bound even when an upper one is set", () => {
  const all = [v("ourAncient", 300), v("alienAncient", 300)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  assert.deepEqual(filterDepth(all, since, ["ourAncient"], until).map((x) => x.id), ["ourAncient"]);
});

test("a video without a date never enters a range — not even a tracked one", () => {
  const all = [{ id: "noDate", publishedAt: null }];
  assert.deepEqual(filterDepth(all, NOW - 20 * DAY, ["noDate"], NOW - 10 * DAY).map((x) => x.id), []);
});

test("no bounds at all — the list comes back as is", () => {
  const all = [v("a", 1), v("b", 900)];
  assert.deepEqual(filterDepth(all, null, [], null).map((x) => x.id), ["a", "b"]);
});

// --- потолок числа видео (миграция v19) -------------------------------------------------------

test("the cap stops the scroll as soon as that many videos are collected within the depth", () => {
  assert.deepEqual(listStop({ mode: "all", hasMore: true, maxVideos: 50, inDepth: 49 }), { stop: false, reason: null });
  assert.deepEqual(listStop({ mode: "all", hasMore: true, maxVideos: 50, inDepth: 50 }), { stop: true, reason: "max" });
  assert.deepEqual(listStop({ mode: "all", hasMore: true, maxVideos: null, inDepth: 900 }), { stop: false, reason: null }, "without a cap we scroll as before");
});

test("under scope \"ours only\" the cap does not stop the scroll — it does not cut tracked videos", () => {
  const step = listStop({ mode: "ours", trackedIds: ["a", "b"], seenIds: ["a"], hasMore: true, maxVideos: 1, inDepth: 99 });
  assert.deepEqual(step, { stop: false, reason: null });
});

test("only the first maxVideos newest ones go to the DB — the list order stays", () => {
  const all = [v("new", 1), v("old", 5), v("mid", 3)];
  assert.deepEqual(filterDepth(all, null, [], null, 2).map((x) => x.id), ["new", "mid"], "the oldest is cut off, the order is unchanged");
  assert.deepEqual(filterDepth(all, null, [], null, 9).map((x) => x.id), ["new", "old", "mid"], "a cap above the video count cuts nothing");
  assert.deepEqual(filterDepth([v("a", 1), { id: "nodate", publishedAt: null }], null, [], null, 1).map((x) => x.id), ["a"], "no date counts as the oldest");
});

test("a tracked video survives the cap even when it is not among the newest", () => {
  const all = [v("new", 1), v("mid", 3), v("ourOld", 300)];
  assert.deepEqual(filterDepth(all, SINCE, ["ourOld"], null, 1).map((x) => x.id), ["new", "ourOld"]);
});

test("the cap is normalized to one shape, and merging takes the wider one (null wins)", () => {
  assert.equal(videoCap("50"), 50);
  assert.equal(videoCap(null), null);
  assert.equal(videoCap(0), null, "zero means \"no cap\", not \"zero videos\"");
  assert.equal(videoCap("nonsense"), null);
  assert.equal(widerCap(20, 50), 50);
  assert.equal(widerCap(20, null), null);
  assert.equal(widerCap(null, null), null);
});

// --- приведение глубины ---------------------------------------------------------------------

test("known depths pass through as is, bounds only for a range", () => {
  assert.deepEqual(normalizeDepth("week"), { depth: "week", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth("month"), { depth: "month", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth("MONTH "), { depth: "month", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth("all"), { depth: "all", from: null, to: null, note: null });
  assert.deepEqual(normalizeDepth(null), { depth: "all", from: null, to: null, note: null });
});

test("an unknown depth falls back to \"all\" — and there is something to say in the log", () => {
  const got = normalizeDepth("year");
  assert.equal(got.depth, "all");
  assert.match(got.note, /unknown depth/);
});

test("\"range\" without bounds (or backwards) falls back to \"all\" with a note", () => {
  for (const args of [["range", null, null], ["range", "2026-09-01", null], ["range", "2026-09-09", "2026-09-01"], ["range", "2026-09-01", "2026-09-01"]]) {
    const got = normalizeDepth(...args);
    assert.equal(got.depth, "all", `${args[1]}…${args[2]}`);
    assert.match(got.note, /range/);
  }
});

test("\"range\" with bounds stays a range, and the edges become ISO", () => {
  const got = normalizeDepth("range", "2026-09-01T00:00:00Z", new Date(Date.parse("2026-09-09T00:00:00Z")));
  assert.equal(got.depth, "range");
  assert.equal(got.note, null);
  assert.equal(got.from, "2026-09-01T00:00:00.000Z");
  assert.equal(got.to, "2026-09-09T00:00:00.000Z");
});

// --- глубина словом --------------------------------------------------------------------------

test("the depth word — one for the whole collector", () => {
  assert.equal(depthWord("all"), "all");
  assert.equal(depthWord("week"), "week");
  assert.equal(depthWord("month"), "month");
  assert.equal(depthWord("range"), "range");
  assert.equal(depthWord("nonsense"), "all");
});

test("a range gets its edges appended to the word, other depths do not", () => {
  const from = new Date(2026, 8, 1, 0, 0, 0, 0);      // местные сутки: так их задаёт человек
  const to = new Date(2026, 8, 9, 23, 59, 59, 999);
  assert.equal(depthLabel("range", from, to), "range 01.09–09.09");
  assert.equal(depthLabel("month"), "month");
  assert.equal(depthLabel("all"), "all");
  assert.equal(depthLabel("range", null, null), "range", "the edges are lost — at least the word remains");
});

// --- период из командной строки --------------------------------------------------------------

test("dates are taken as whole local days: --to runs to the end of its day", () => {
  const got = dayRange("2026-09-01", "2026-09-09");
  assert.equal(Date.parse(got.from), new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
  assert.equal(Date.parse(got.to), new Date(2026, 8, 9, 23, 59, 59, 999).getTime(), "otherwise the ninth is lost entirely");
});

test("a single day is a range too", () => {
  const got = dayRange("2026-09-05", "2026-09-05");
  assert.equal(Date.parse(got.to) - Date.parse(got.from), DAY - 1);
});

test("a full timestamp is taken as is", () => {
  const got = dayRange("2026-09-01T12:00:00Z", "2026-09-02T12:00:00Z");
  assert.equal(got.from, "2026-09-01T12:00:00.000Z");
  assert.equal(got.to, "2026-09-02T12:00:00.000Z");
});

test("garbage and a reversed range give null, not a silent substitution", () => {
  assert.equal(dayRange("", "2026-09-09"), null);
  assert.equal(dayRange("2026-09-09", null), null);
  assert.equal(dayRange("yesterday", "today"), null);
  assert.equal(dayRange("2026-09-09", "2026-09-01"), null);
});

// --- сторож недобора: пришло меньше, чем мы знаем (владелец, 2026-09-16) --------------------

test("no shortfall: the list arrived and the profile agrees with it", () => {
  assert.equal(shortfall({ rawCount: 12, knownTotal: 12, profileCount: 12, listEnded: true }), null);
  assert.equal(shortfall({ rawCount: 13, knownTotal: 12, profileCount: 12, listEnded: true }), null, "a new video is not trouble");
});

test("empty DB and empty profile: stay silent, there is nothing to judge", () => {
  assert.equal(shortfall({ rawCount: 0, knownTotal: 0, profileCount: null }), null);
  assert.equal(shortfall({ rawCount: 0, knownTotal: 0, profileCount: 0 }), null);
});

test("dead session: the header was read, the feed is empty — the loudest case", () => {
  const got = shortfall({ rawCount: 0, knownTotal: 3, profileCount: 3 });
  assert.equal(got?.kind, "empty");
  assert.match(got.text, /in DB 3/);
  assert.match(got.text, /profile says 3/);
});

test("zero videos with a non-empty DB is trouble even when the platform says nothing about the post count", () => {
  const got = shortfall({ rawCount: 0, knownTotal: 7, profileCount: null });
  assert.equal(got?.kind, "empty");
  assert.doesNotMatch(got.text, /profile says/);
});

test("🔴 \"week\" for a creator silent for a week is NOT an empty list: we judge by what arrived, not by what was kept", () => {
  // Первая версия сторожа брала видео после отбора по глубине и здесь кричала бы «список пуст».
  assert.equal(shortfall({ rawCount: 7, knownTotal: 7, profileCount: 7 }), null);
});

test("🔴 a partially scrolled list of a big account does not count as a shortfall", () => {
  // @mrbeast, 10.09: список дал 67 видео при 473 по профилю — прокрутка упёрлась в предел.
  assert.equal(shortfall({ rawCount: 67, knownTotal: 340, profileCount: 473, listEnded: false }), null);
});

test("a finished list shorter than the profile is already a shortfall", () => {
  const got = shortfall({ rawCount: 10, knownTotal: 12, profileCount: 12, listEnded: true });
  assert.equal(got?.kind, "short");
  assert.match(got.text, /list ended at 10 videos, but the profile says 12/);
});

// --- пропавшие видео поимённо (владелец, 2026-09-16) ----------------------------------------

const K = (id, day) => ({ id, publishedAt: `2026-08-${day}T12:00:00Z`, url: `https://x/${id}` });

test("finished list: videos from the DB missing from it count as vanished — newest first", () => {
  // @orandocom.lis 16.09: в базе 7, TikTok отдал 2 и сказал hasMore=false, профиль — 2.
  const known = [K("a", 29), K("b", 28), K("c", 23), K("d", 27), K("e", 28), K("f", 26), K("g", 25)];
  const got = vanishedVideos({ known, seenIds: ["a", "b"], listEnded: true, profileCount: 2 });
  assert.equal(got.judged, true);
  assert.deepEqual(got.gone.map((v) => v.id), ["e", "d", "f", "g", "c"]);
});

test("🔴 an unfinished list is not judged: the video may simply lie further down", () => {
  const got = vanishedVideos({ known: [K("a", 29), K("old", 1)], seenIds: ["a"], listEnded: false, profileCount: 2 });
  assert.deepEqual(got, { judged: false, why: "not-ended", gone: [] });
});

test("a video marked deleted shows up again — the mark is cleared, even from an unfinished list", () => {
  assert.deepEqual(returnedGone(["a", "b", "c"], ["c", "x", "a"]), ["a", "c"]);
  assert.deepEqual(returnedGone(["a"], []), []);
  assert.deepEqual(returnedGone([], ["a"]), []);
  assert.deepEqual(returnedGone(undefined, undefined), []);
  assert.deepEqual(returnedGone([7], ["7"]), ["7"], "ids compare as strings");
});

test("🔴 a finished empty list makes every known video deleted — each by name, not \"empty list\" every day", () => {
  // @orandocom.lis 17.09: в базе 7, TikTok отдал 0 и сказал hasMore=false, профиль — 0.
  const got = vanishedVideos({ known: [K("a", 29), K("b", 28)], seenIds: [], listEnded: true, profileCount: 0 });
  assert.equal(got.judged, true);
  assert.deepEqual(got.gone.map((v) => v.id), ["a", "b"]);
});

test("🔴 the profile counter does not matter: a finished list shorter than the profile still judges every video", () => {
  const got = vanishedVideos({ known: [K("a", 29), K("b", 28), K("c", 27)], seenIds: ["a"], listEnded: true, profileCount: 3 });
  assert.equal(got.judged, true);
  assert.deepEqual(got.gone.map((v) => v.id), ["b", "c"]);
});

test("everything is in place — nothing vanished; ids compare as strings", () => {
  const got = vanishedVideos({ known: [{ id: 17900, publishedAt: null }], seenIds: ["17900"], listEnded: true, profileCount: null });
  assert.equal(got.judged, true);
  assert.deepEqual(got.gone, []);
});

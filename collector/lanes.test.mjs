// Чистые куски правки 2026-09-08, вечер: две полосы, склейка галочек просьб и решение
// «это видео за комментариями не открываем».
//
// Браузера здесь нет вовсе — это расчёты, и проверяются они на выдуманных строках.

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLanes, laneOf, pauseAfter, pickComments, profileGone } from "./sync.mjs";
import { groupRequests, covers } from "./requests.mjs";

// --- деление на полосы --------------------------------------------------------------------

test("creators are split by platform, the order inside a lane is kept", () => {
  const creators = [
    { handle: "toplombard_warszaw", platform: "tiktok" },
    { handle: "instagram", platform: "instagram" },
    { handle: "khaby.lame", platform: "tiktok" },
    { handle: "nasa", platform: "instagram" },
  ];
  const { tt, ig } = splitLanes(creators);
  assert.deepEqual(tt.map((c) => c.handle), ["toplombard_warszaw", "khaby.lame"]);
  assert.deepEqual(ig.map((c) => c.handle), ["instagram", "nasa"]);
});

test("no platform given — it is TikTok; a foreign platform goes there too and fails with its own error", () => {
  assert.equal(laneOf({ handle: "x" }), "tt");
  assert.equal(laneOf({ handle: "x", platform: "youtube" }), "tt");
  assert.equal(laneOf({ handle: "x", platform: "instagram" }), "ig");
});

test("an empty list does not break the lanes", () => {
  assert.deepEqual(splitLanes([]), { tt: [], ig: [] });
  assert.deepEqual(splitLanes(undefined), { tt: [], ig: [] });
});

// --- паузы --------------------------------------------------------------------------------

test("a pause only between TikTok creators", () => {
  assert.equal(pauseAfter("tt"), true);
  assert.equal(pauseAfter("ig"), false, "Instagram shares one browser — there is nothing to wait for");
});

test("after \"profile not found\" there is no pause: there was no page, and no queue to TikTok either", () => {
  assert.equal(pauseAfter("tt", "profile not found: @demo_tiktok"), false);
  assert.equal(pauseAfter("tt", "TikTok stop screen on profile @khaby.lame"), true, "a captcha is exactly the reason to wait it out");
  assert.equal(pauseAfter("ig", "Instagram: profile not found: @demo"), false);
});

test("the \"profile gone\" mark (v33): TikTok and the Instagram browser — yes, the Graph API \"or not a business account\" — no", () => {
  assert.equal(profileGone("profile not found: @demo_tiktok"), true);
  assert.equal(profileGone("Instagram: profile not found: @demo"), true);
  assert.equal(profileGone("Instagram: profile not found or not a business account: @demo"), false);
  assert.equal(profileGone("TikTok stop screen on profile @demo"), false);
  assert.equal(profileGone(null), false);
});

// --- склейка просьб -----------------------------------------------------------------------

const req = (id, extra = {}) => ({ id, creator_id: null, depth: "all", requested_by: null, ...extra });

test("two requests of the same scope and depth — one run, the checkboxes add up by \"or\"", () => {
  const groups = groupRequests([
    req(1, { comments: false, replies: false }),
    req(2, { comments: true, replies: false }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [1, 2]);
  assert.equal(groups[0].comments, true, "true swallows false");
  assert.equal(groups[0].replies, false, "nobody asked for branches — so we do not expand them");
});

test("a run over everyone takes in a single-creator request together with its checkboxes", () => {
  const groups = groupRequests([
    req(1, { creator_id: "c1", depth: "all", comments: true, replies: true }),
    req(2, { creator_id: null, depth: "all", comments: false, replies: false }),
  ]);
  assert.equal(groups.length, 1, "the single-creator request is covered by the run over everyone");
  assert.deepEqual(groups[0].ids.sort(), [1, 2]);
  assert.equal(groups[0].comments, true, "the swallowed request does not lose its comments");
  assert.equal(groups[0].replies, true);
});

test("\"everyone, week\" does not cover \"this creator, all\" — two runs, each with its own checkboxes", () => {
  const groups = groupRequests([
    req(1, { creator_id: null, depth: "week", comments: false, replies: false }),
    req(2, { creator_id: "c1", depth: "all", comments: true, replies: true }),
  ]);
  assert.equal(groups.length, 2);
  const wide = groups.find((g) => g.creatorId === null);
  const narrow = groups.find((g) => g.creatorId === "c1");
  assert.equal(wide.comments, false);
  assert.equal(narrow.comments, true);
});

test("no fields at all (an old request) — we take it as \"collect\", as it was before the checkboxes", () => {
  const [group] = groupRequests([req(1)]);
  assert.equal(group.comments, true);
  assert.equal(group.replies, true);
});

test("coverage: wider in scope and not shallower in depth", () => {
  assert.equal(covers({ creatorId: null, depth: "all" }, { creatorId: "c1", depth: "week" }), true);
  assert.equal(covers({ creatorId: null, depth: "week" }, { creatorId: "c1", depth: "all" }), false);
  assert.equal(covers({ creatorId: "c1", depth: "all" }, { creatorId: "c2", depth: "all" }), false);
});

// --- глубина «месяц» и «период» (миграция v18) ---------------------------------------------

const RANGE = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z" };
const other = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" };
const grp = (depth, extra = {}) => ({ creatorId: null, depth, depthFrom: null, depthTo: null, ...extra });

test("\"month\" covers \"week\" and itself, but not \"all\"", () => {
  assert.equal(covers(grp("month"), grp("week")), true, "30 days include 7");
  assert.equal(covers(grp("month"), grp("month")), true);
  assert.equal(covers(grp("month"), grp("all")), false);
  assert.equal(covers(grp("week"), grp("month")), false, "a week is shallower than a month");
  assert.equal(covers(grp("all"), grp("month")), true);
});

test("\"range\" covers ONLY exactly the same range", () => {
  const a = grp("range", { depthFrom: RANGE.from, depthTo: RANGE.to });
  const b = grp("range", { depthFrom: other.from, depthTo: other.to });
  assert.equal(covers(a, { ...a }), true);
  assert.equal(covers(a, b), false, "another range has its own upper boundary");
  assert.equal(covers(a, grp("week")), false, "a range is not deeper than a week — it has its own top");
  assert.equal(covers(grp("month"), a), false);
  assert.equal(covers(grp("all"), a), true, "\"all\" takes in a range too: it will bring more than was asked for");
});

test("two different ranges — two runs, identical ones — a single run", () => {
  const two = groupRequests([
    req(1, { depth: "range", depth_from: RANGE.from, depth_to: RANGE.to }),
    req(2, { depth: "range", depth_from: other.from, depth_to: other.to }),
  ]);
  assert.equal(two.length, 2, "there is nothing to merge \"1 to 9\" and \"1 to 9 August\" with");
  const one = groupRequests([
    req(3, { depth: "range", depth_from: RANGE.from, depth_to: RANGE.to, comments: false }),
    req(4, { depth: "range", depth_from: RANGE.from, depth_to: RANGE.to, comments: true }),
  ]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].ids, [3, 4]);
  assert.equal(one[0].comments, true, "the checkboxes add up by \"or\" inside a range too");
  assert.equal(one[0].depthFrom, RANGE.from);
  assert.equal(one[0].depthTo, RANGE.to);
});

test("\"range\" without boundaries arrives as \"all\" — the database would not allow it, but the request may be an old one", () => {
  const [group] = groupRequests([req(1, { depth: "range" })]);
  assert.equal(group.depth, "all");
  assert.equal(group.depthFrom, null);
  assert.equal(group.depthTo, null);
});

test("boundaries are understood in the parsed form too: the resident puts depthFrom in the queue", () => {
  const [group] = groupRequests([req(1, { depth: "range", depthFrom: RANGE.from, depthTo: RANGE.to })]);
  assert.equal(group.depth, "range", "a range from the site must not get lost on the way through the resident");
  assert.equal(group.depthFrom, RANGE.from);
});

test("a \"month\" run takes in a \"week\" request, and not the other way round", () => {
  const groups = groupRequests([
    req(1, { creator_id: "c1", depth: "week" }),
    req(2, { creator_id: null, depth: "month" }),
  ]);
  assert.equal(groups.length, 1, "a month is wider than a week — the single-creator request is covered");
  assert.deepEqual(groups[0].ids.sort(), [1, 2]);
  assert.equal(groups[0].depth, "month");
});

// --- «комментарии не менялись» ------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-08T20:00:00Z");
const SINCE = NOW - 7 * DAY;
const video = (id, comments, daysAgo) => ({
  id,
  comments,
  publishedAt: new Date(NOW - daysAgo * DAY).toISOString(),
});

test("the comment count is the same as at the last collection — we do not open the video", () => {
  const videos = [video("a", 42, 1), video("b", 43, 1)];
  const known = new Map([["a", 42], ["b", 42]]);
  const { picked, unchanged } = pickComments(videos, known, SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["b"], "b gained comments — we collect it");
  assert.deepEqual(unchanged.map((v) => v.id), ["a"]);
});

test("the first time (null in the database or nothing at all) — we always collect", () => {
  const videos = [video("a", 10, 1), video("b", 10, 1)];
  const known = new Map([["a", null]]);
  const { picked, unchanged } = pickComments(videos, known, SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["a", "b"]);
  assert.equal(unchanged.length, 0);
});

test("there are FEWER comments (some were deleted) — that is a change too, we collect", () => {
  const { picked } = pickComments([video("a", 8, 1)], new Map([["a", 12]]), SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["a"]);
});

test("old and empty ones go neither into the collected nor into \"unchanged\"", () => {
  const videos = [video("old", 100, 30), video("empty", 0, 1), { id: "nodate", comments: 5, publishedAt: null }];
  const { picked, unchanged } = pickComments(videos, new Map(), SINCE);
  assert.equal(picked.length, 0);
  assert.equal(unchanged.length, 0, "what is skipped by freshness does not count as \"unchanged\"");
});

// --- Окно шага = глубина обхода (владелец, 2026-09-09) --------------------------------------

test("the \"month\" window: a thirty-day-old video is taken, an older one is not", () => {
  const videos = [video("m", 5, 20), video("older", 5, 40)];
  const { picked } = pickComments(videos, new Map(), NOW - 30 * DAY);
  assert.deepEqual(picked.map((v) => v.id), ["m"], "a month-deep run collects comments for a month");
});

test("the \"all\" window (no boundaries) — every video with comments is taken, even one without a date", () => {
  const videos = [video("old", 100, 300), video("empty", 0, 1), { id: "nodate", comments: 5, publishedAt: null }];
  const { picked, unchanged } = pickComments(videos, new Map(), null);
  assert.deepEqual(picked.map((v) => v.id), ["old", "nodate"], "depth \"all\" has no date limit");
  assert.equal(unchanged.length, 0);
});

test("the \"all\" window cancels neither \"unchanged\" nor \"ours only\"", () => {
  const known = new Map([
    ["same", { count: 7, ours: true }],
    ["alien", { count: null, ours: false }],
  ]);
  const { picked, unchanged, foreign } = pickComments([video("same", 7, 200), video("alien", 3, 200)], known, null);
  assert.equal(picked.length, 0);
  assert.deepEqual(unchanged.map((v) => v.id), ["same"]);
  assert.deepEqual(foreign.map((v) => v.id), ["alien"]);
});

test("the database counter arrives as a string — the comparison is numeric all the same", () => {
  const { picked, unchanged } = pickComments([video("a", 42, 1)], new Map([["a", "42"]]), SINCE);
  assert.equal(picked.length, 0);
  assert.equal(unchanged.length, 1);
});

// --- Только наши видео (владелец, 2026-09-08: счётчики по всем, тексты — по нашим) ---

test("a video that is not ours is not taken for texts — it goes to foreign", () => {
  const videos = [video("ours", 10, 1), video("alien", 10, 1)];
  const known = new Map([["ours", { count: null, ours: true }], ["alien", { count: null, ours: false }]]);
  const { picked, unchanged, foreign } = pickComments(videos, known, SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["ours"]);
  assert.deepEqual(foreign.map((v) => v.id), ["alien"]);
  assert.equal(unchanged.length, 0);
});

test("the request \"videos that are not ours too\" collects from everyone, but \"unchanged\" applies to them as well", () => {
  const videos = [video("ours", 10, 1), video("alien", 10, 1), video("same", 5, 1)];
  const known = new Map([
    ["ours", { count: null, ours: true }],
    ["alien", { count: null, ours: false }],
    ["same", { count: 5, ours: false }],
  ]);
  const { picked, unchanged, foreign } = pickComments(videos, known, SINCE, { allVideos: true });
  assert.deepEqual(picked.map((v) => v.id), ["ours", "alien"]);
  assert.deepEqual(unchanged.map((v) => v.id), ["same"]);
  assert.equal(foreign.length, 0);
});

test("the database said nothing about the video (no row) — it counts as ours and is collected", () => {
  const { picked, foreign } = pickComments([video("new", 3, 1)], new Map(), SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["new"]);
  assert.equal(foreign.length, 0);
});

test("all_videos merges by \"or\", and without the field it is false", () => {
  const groups = groupRequests([
    req(1, { comments: true, replies: true }),
    req(2, { comments: true, replies: true, all_videos: true }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].allVideos, true, "one request for \"not ours too\" — the run collects from everyone");
  const [plain] = groupRequests([req(3, { comments: true, replies: true })]);
  assert.equal(plain.allVideos, false, "no field — ours only, as always");
});

test("all_videos is understood in the parsed form too: the resident puts allVideos in the queue", () => {
  const [group] = groupRequests([req(1, { allVideos: true })]);
  assert.equal(group.allVideos, true, "a checkbox from the site must not get lost on the way through the resident");
});

// --- Охват видео: всё или только наши (владелец, 2026-09-09; миграция v17) ---

test("the scope merges by \"or\": a single request for \"all\" — the run goes over the whole list", () => {
  const groups = groupRequests([
    req(1, { videos: "ours" }),
    req(2, { videos: "all" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].videos, "all", "whoever asked for the whole list must not be left without foreign videos");
});

test("\"ours only\" happens only when every request in the group asked for it", () => {
  const [group] = groupRequests([req(1, { videos: "ours" }), req(2, { videos: "ours" })]);
  assert.equal(group.videos, "ours");
});

test("there is no scope field at all (an old request) — we take it as \"all\"", () => {
  const [group] = groupRequests([req(1)]);
  assert.equal(group.videos, "all");
});

test("a swallowed request brings its scope to the covering run", () => {
  const groups = groupRequests([
    req(1, { creator_id: "c1", depth: "all", videos: "all" }),
    req(2, { creator_id: null, depth: "all", videos: "ours" }),
  ]);
  assert.equal(groups.length, 1, "the single-creator request is covered by the run over everyone");
  assert.equal(groups[0].videos, "all", "the single-creator one asked for the whole list — the run over everyone goes over everything");
});

// --- Жёлтые видео: счётчики да, тексты нет ---

test("a yellow video is counted apart from a foreign one, but gets no texts either", () => {
  const videos = [video("ours", 10, 1), video("yellow", 10, 1), video("alien", 10, 1)];
  const known = new Map([
    ["ours", { count: null, ours: true, watch: false }],
    ["yellow", { count: null, ours: false, watch: true }],
    ["alien", { count: null, ours: false, watch: false }],
  ]);
  const { picked, foreign, watched } = pickComments(videos, known, SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["ours"]);
  assert.deepEqual(watched.map((v) => v.id), ["yellow"], "\"watching the history\" means counters, not texts");
  assert.deepEqual(foreign.map((v) => v.id), ["alien"]);
});

test("the request \"videos that are not ours too\" collects texts from yellow ones as well", () => {
  const known = new Map([["yellow", { count: null, ours: false, watch: true }]]);
  const { picked, watched, foreign } = pickComments([video("yellow", 4, 1)], known, SINCE, { allVideos: true });
  assert.deepEqual(picked.map((v) => v.id), ["yellow"]);
  assert.equal(watched.length, 0);
  assert.equal(foreign.length, 0);
});

// --- Комментарии при глубине «период» (миграция v18) ---

test("with a range the texts are collected from videos IN the range, not from yesterday's", () => {
  const videos = [video("today", 5, 0), video("inRange", 5, 15), video("tooOld", 5, 40)];
  const since = NOW - 20 * DAY, until = NOW - 10 * DAY;
  const { picked } = pickComments(videos, new Map(), since, { untilMs: until });
  assert.deepEqual(picked.map((v) => v.id), ["inRange"], "a slice of last month is not about yesterday's discussions");
});

test("no upper boundary — the step works as before, over the fresh ones", () => {
  const videos = [video("today", 5, 0), video("old", 5, 30)];
  const { picked } = pickComments(videos, new Map(), SINCE, { untilMs: null });
  assert.deepEqual(picked.map((v) => v.id), ["today"]);
});

test("what the upper boundary cuts off goes neither into \"unchanged\" nor into foreign", () => {
  const known = new Map([["today", { count: 5, ours: false }]]);
  const { picked, unchanged, foreign } = pickComments([video("today", 5, 0)], known, NOW - 20 * DAY, { untilMs: NOW - 10 * DAY });
  assert.equal(picked.length, 0);
  assert.equal(unchanged.length, 0);
  assert.equal(foreign.length, 0, "a video outside the range does not concern the step at all");
});

test("rows without the watch field (the old shape) count simply as foreign", () => {
  const known = new Map([["alien", { count: null, ours: false }]]);
  const { watched, foreign } = pickComments([video("alien", 4, 1)], known, SINCE);
  assert.equal(watched.length, 0);
  assert.deepEqual(foreign.map((v) => v.id), ["alien"]);
});

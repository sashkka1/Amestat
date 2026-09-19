// Оценка объёма обхода и калибровка (`estimate.mjs`). Ни базы, ни браузера, ни файлов —
// только расчёты на выдуманных строках.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMED_COMMENTS,
  ASSUMED_VIDEOS,
  DEFAULT_TIMING,
  PER_SCROLL,
  assumedVideos,
  calibrateComments,
  calibrateList,
  commentCandidate,
  commentSeconds,
  commentUnits,
  commentsWindow,
  estimateCreator,
  estimateRun,
  etaSeconds,
  foldEma,
  listScrolls,
  livePrices,
  medianOf,
  normalizeTiming,
  paceFrom,
  percentDone,
  remainingOf,
  remainingSeconds,
  reviseAfterList,
  videoUnits,
} from "./estimate.mjs";

// --- калибровка: приведение и среднее ------------------------------------------------------

test("a bad calibration is replaced by defaults per key, not wholesale", () => {
  const t = normalizeTiming({ "page.tiktok": 12, "comments.page.browser": "no", extra: 5 });
  assert.equal(t["page.tiktok"], 12, "a valid value stays");
  assert.equal(t["comments.page.browser"], DEFAULT_TIMING["comments.page.browser"]);
  assert.equal(t["list.tiktok"], DEFAULT_TIMING["list.tiktok"]);
  assert.equal("extra" in t, false, "extra keys do not enter the calculation");
});

test("the branch share is not seconds: zero is legal, above one is clamped, garbage falls back to the default", () => {
  assert.equal(normalizeTiming({ "replies.share": 0 })["replies.share"], 0, "there were no branches at all");
  assert.equal(normalizeTiming({ "replies.share": 3 })["replies.share"], 1);
  assert.equal(normalizeTiming({ "replies.share": -1 })["replies.share"], DEFAULT_TIMING["replies.share"]);
  assert.equal(normalizeTiming({ "replies.share": "" })["replies.share"], DEFAULT_TIMING["replies.share"]);
});

test("zero and negative are garbage too: a step never costs nothing", () => {
  const t = normalizeTiming({ "list.tiktok": 0, "page.tiktok": -3 });
  assert.equal(t["list.tiktok"], DEFAULT_TIMING["list.tiktok"]);
  assert.equal(t["page.tiktok"], DEFAULT_TIMING["page.tiktok"]);
});

test("the moving average pulls the old value by alpha, and the first measurement is taken as is", () => {
  assert.equal(foldEma(10, 20, 0.3), 13);
  assert.equal(foldEma(null, 20, 0.3), 20, "no past — trust the measurement");
  assert.equal(foldEma(10, null, 0.3), 10, "no measurement — the old value stays");
});

// --- калибровка шага списка ----------------------------------------------------------------

test("a list step twice as long as expected raises both prices, keeping their ratio", () => {
  const before = { "list.tiktok": 60, "page.tiktok": 6 };
  // 60 + 5×6 = 90 предсказанных, факт 180 → множитель 2.
  const after = calibrateList(before, "tiktok", 180, 5, 1);
  assert.equal(after["list.tiktok"], 120);
  assert.equal(after["page.tiktok"], 12);
  assert.equal(after["list.instagram"], DEFAULT_TIMING["list.instagram"], "the other platform does not move");
});

test("no scrolls happened — every second goes into the base, the scroll price is untouched", () => {
  const after = calibrateList({ "list.tiktok": 60, "page.tiktok": 6 }, "tiktok", 100, 0, 1);
  assert.equal(after["list.tiktok"], 100);
  assert.equal(after["page.tiktok"], 6);
});

test("alpha smooths: 0.3 of the difference, not the whole difference", () => {
  const after = calibrateList({ "list.instagram": 20, "page.instagram": 5 }, "instagram", 90, 2, 0.3);
  // предсказано 30, факт 90 → множитель 3; база: 20×0.7 + 60×0.3 = 32.
  assert.equal(Math.round(after["list.instagram"] * 10) / 10, 32);
  assert.equal(Math.round(after["page.instagram"] * 10) / 10, 8);
});

test("a zero or negative step duration does not spoil the calibration", () => {
  const before = normalizeTiming({});
  assert.deepEqual(calibrateList(before, "tiktok", 0, 3), before);
  assert.deepEqual(calibrateList(before, "tiktok", -5, 3), before);
});

// --- калибровка шага комментариев ----------------------------------------------------------

const B = { "comments.page.browser": 10, "replies.branch.browser": 5, "replies.share": 0.5 };

test("browser without branches: the whole step time is the page price", () => {
  const after = calibrateComments(B, { seconds: 200, pages: 10, roots: 50 }, { replies: false, alpha: 1 });
  assert.equal(after["comments.page.browser"], 20);
  assert.equal(after["replies.branch.browser"], 5, "branches were not expanded — their price is unknown");
});

test("browser with branches: one measurement covers both prices and moves them by one factor", () => {
  // 4 страницы × 10 + 20 корней × 0,5 × 5 = 90 предсказанных, факт 180 → множитель 2.
  const after = calibrateComments(B, { seconds: 180, pages: 4, roots: 20 }, { alpha: 1 });
  assert.equal(after["comments.page.browser"], 20);
  assert.equal(after["replies.branch.browser"], 10);
});

test("direct path: roots, branches and the share are each calibrated by their own measurement", () => {
  // Обход #107: сотня корней — 5 страниц оценки за 7,5 с, 30 веток за 27 с.
  const after = calibrateComments(DEFAULT_TIMING, { pages: 5, roots: 100, pageSeconds: 7.5, branchSeconds: 27, branches: 30 }, { direct: true, alpha: 1 });
  assert.equal(after["comments.page.direct"], 1.5, "root seconds ÷ estimated pages");
  assert.equal(after["replies.branch.direct"], 0.9);
  assert.equal(after["replies.share"], 0.3, "30 branches per 100 roots");
  assert.equal(after["comments.page.browser"], DEFAULT_TIMING["comments.page.browser"], "the browser path is untouched");
});

test("not a single branch — the share honestly goes down instead of staying put", () => {
  const after = calibrateComments({ "replies.share": 0.3 }, { pages: 1, roots: 3, pageSeconds: 0.4, branchSeconds: 0, branches: 0 }, { direct: true, alpha: 0.5 });
  assert.equal(after["replies.share"], 0.15);
});

test("the comments step covered no pages — there is nothing to calibrate with", () => {
  const before = normalizeTiming({});
  assert.deepEqual(calibrateComments(before, { seconds: 300, pages: 0 }), before);
  assert.deepEqual(calibrateComments(before, { pages: 3 }), before, "neither seconds nor a breakdown");
});

// --- единицы шага комментариев: страницы и корни ----------------------------------------------

test("a video is counted in pages of 20 from its counter, clipped by the cap", () => {
  // @mrbeast: 7700 комментариев, потолок 100 → 100 корней → 5 страниц.
  assert.deepEqual(videoUnits(7700, 100), { pages: 5, roots: 100 });
  assert.deepEqual(videoUnits(3, 100), { pages: 1, roots: 3 }, "a small video is one page");
  assert.deepEqual(videoUnits(45, 100), { pages: 3, roots: 45 });
  assert.deepEqual(videoUnits(500, 300), { pages: 15, roots: 300 }, "its own cap");
  assert.deepEqual(videoUnits(7700), { pages: 5, roots: 100 }, "the default cap is 100");
});

test("the counter is unknown — one full page, not zero", () => {
  assert.deepEqual(videoUnits(null), { pages: 1, roots: ASSUMED_COMMENTS });
  assert.deepEqual(videoUnits(0), { pages: 1, roots: ASSUMED_COMMENTS });
});

test("units for a set of videos are the sum over the videos", () => {
  assert.deepEqual(commentUnits([7700, 3, 45], 100), { videos: 3, pages: 9, roots: 148 });
  assert.deepEqual(commentUnits([]), { videos: 0, pages: 0, roots: 0 });
});

test("@mrbeast: a video with 7700 comments takes 31 s, not 2.2 s, and 67 such videos take 35 minutes", () => {
  const one = commentSeconds(videoUnits(7700, 100), DEFAULT_TIMING, { direct: true });
  // 5 страниц × 0,8 + 100 корней × 0,3 × 0,9 = 4 + 27.
  assert.equal(Math.round(one.comments * 10) / 10, 4);
  assert.equal(Math.round(one.replies * 10) / 10, 27);
  const run = commentSeconds(commentUnits(Array(67).fill(7700), 100), DEFAULT_TIMING, { direct: true });
  assert.equal(Math.round(run.comments + run.replies), 2077);
  const noBranches = commentSeconds(videoUnits(7700, 100), DEFAULT_TIMING, { direct: true, replies: false });
  assert.equal(noBranches.replies, 0, "branches are not expanded — they are absent from the estimate too");
});

// --- прокрутки -----------------------------------------------------------------------------

test("depth \"all\": scrolls are counted over every known video of the creator", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "all", videosTotal: 100 }), 5, "20 per scroll");
  assert.equal(listScrolls({ platform: "instagram", depth: "all", videosTotal: 100 }), 9, "12 per scroll");
  assert.equal(PER_SCROLL.tiktok, 20);
});

test("the first page always arrives: there is never less than one scroll", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "week", inDepth: 0 }), 1);
  assert.equal(listScrolls({ platform: "tiktok", mode: "ours", toTracked: 0 }), 1, "no tracked videos — the first page");
});

test("depth \"week\" counts only the videos from that week, not the whole history", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "week", videosTotal: 500, inDepth: 21 }), 2);
});

test("the video cap trims scrolls, but not under scope \"ours only\"", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "all", videosTotal: 500, maxVideos: 50 }), 3);
  assert.equal(
    listScrolls({ platform: "tiktok", mode: "ours", toTracked: 200, maxVideos: 20 }),
    10,
    "for tracked videos we scroll past the cap — that is scope.mjs's rule",
  );
});

test("\"ours only\": scroll down to the oldest tracked video, depth is irrelevant", () => {
  assert.equal(listScrolls({ platform: "tiktok", mode: "ours", depth: "week", toTracked: 61, inDepth: 3 }), 4);
});

// --- оценка одного креатора ----------------------------------------------------------------

const T = {
  "list.tiktok": 60, "page.tiktok": 6,
  "list.instagram": 20, "page.instagram": 5,
  "comments.page.browser": 10, "replies.branch.browser": 5,
  "comments.page.direct": 1, "replies.branch.direct": 2,
  "replies.share": 0.5,
};

test("creator estimate: base + scrolls + pages + branches", () => {
  const e = estimateCreator({ handle: "a", platform: "tiktok", scrolls: 5, commentVideos: 2, commentPages: 3, commentRoots: 30 }, T);
  assert.equal(e.list, 90, "60 + 5×6");
  assert.equal(e.comments, 30, "3 pages × 10");
  assert.equal(e.replies, 75, "30 roots × 0.5 × 5");
  assert.equal(e.total, 195);
  assert.equal(e.scrolls, 5, "the units go into the row — the remainder is computed from them");
  assert.equal(e.commentPages, 3);
  assert.equal(e.commentRoots, 30);
});

test("no units given — every video counts as a video with an unknown counter", () => {
  const e = estimateCreator({ platform: "tiktok", scrolls: 1, commentVideos: 2 }, T);
  assert.equal(e.commentPages, 2);
  assert.equal(e.commentRoots, 2 * ASSUMED_COMMENTS);
});

test("comments are off — neither texts nor branches in the estimate", () => {
  const e = estimateCreator({ platform: "tiktok", scrolls: 1, commentVideos: 9, commentPages: 9, commentRoots: 90, comments: false }, T);
  assert.equal(e.comments, 0);
  assert.equal(e.replies, 0);
  assert.equal(e.total, 66);
  assert.equal(e.commentPages, 0);
});

test("branches are off — the texts stay, the branches do not", () => {
  const e = estimateCreator({ platform: "instagram", scrolls: 2, commentVideos: 3, commentPages: 3, commentRoots: 40, replies: false }, T);
  assert.equal(e.list, 30);
  assert.equal(e.comments, 30);
  assert.equal(e.replies, 0);
});

// --- кандидаты на комментарии ---------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-09T12:00:00Z");
const row = (daysAgo, extra = {}) => ({
  id: "v",
  published_at: new Date(NOW - daysAgo * DAY).toISOString(),
  ours: true,
  watch: false,
  ...extra,
});
const WIN = { since: NOW - 7 * DAY, until: null };

test("a candidate is fresh, has comments and is ours", () => {
  assert.equal(commentCandidate(row(1), 5, WIN), true);
  assert.equal(commentCandidate(row(1), 0, WIN), false, "no comments at all");
  assert.equal(commentCandidate(row(30), 5, WIN), false, "too old");
  assert.equal(commentCandidate({ ...row(1), published_at: null }, 5, WIN), false);
});

test("foreign and yellow videos get no texts until \"not ours too\" is asked for", () => {
  const alien = row(1, { ours: false });
  const yellow = row(1, { ours: false, watch: true });
  assert.equal(commentCandidate(alien, 5, WIN), false);
  assert.equal(commentCandidate(yellow, 5, WIN), false, "\"watching the history\" means counters");
  assert.equal(commentCandidate(alien, 5, { ...WIN, allVideos: true }), true);
});

test("the upper bound of a range cuts off the fresh ones", () => {
  const win = { since: NOW - 20 * DAY, until: NOW - 10 * DAY };
  assert.equal(commentCandidate(row(1), 5, win), false);
  assert.equal(commentCandidate(row(15), 5, win), true);
});

test("the comments window equals the run depth: week, month, range", () => {
  const week = commentsWindow({ bounds: { since: NOW - 7 * DAY, until: null } });
  assert.equal(week.since, NOW - 7 * DAY);
  assert.equal(week.until, null);
  const month = commentsWindow({ bounds: { since: NOW - 30 * DAY, until: null } });
  assert.equal(month.since, NOW - 30 * DAY, "a monthly run takes a month of comments");
  const ranged = commentsWindow({ bounds: { since: NOW - 20 * DAY, until: NOW - 10 * DAY } });
  assert.equal(ranged.since, NOW - 20 * DAY);
  assert.equal(ranged.until, NOW - 10 * DAY);
});

test("depth \"all\" — no window at all, neither its own days nor bounds", () => {
  const all = commentsWindow({ bounds: { since: null, until: null } });
  assert.equal(all.since, null);
  assert.equal(all.until, null);
  assert.deepEqual(commentsWindow(), { since: null, until: null }, "no bounds were given at all");
});

test("at depth \"all\" a video without a date becomes a candidate too", () => {
  const none = { since: null, until: null };
  assert.equal(commentCandidate(row(400), 5, none), true, "old — but the depth is \"all\"");
  assert.equal(commentCandidate({ ...row(1), published_at: null }, 5, none), true);
  assert.equal(commentCandidate({ ...row(1), published_at: null }, 0, none), false, "no comments");
});

// --- оценка всего обхода --------------------------------------------------------------------

const creators = [
  { id: "c1", handle: "tt", platform: "tiktok" },
  { id: "c2", handle: "ig", platform: "instagram" },
];
const videos = [
  { creator_id: "c1", id: "a", published_at: new Date(NOW - 1 * DAY).toISOString(), ours: true, watch: false },
  { creator_id: "c1", id: "b", published_at: new Date(NOW - 2 * DAY).toISOString(), ours: false, watch: false },
  { creator_id: "c1", id: "c", published_at: new Date(NOW - 60 * DAY).toISOString(), ours: false, watch: false },
  { creator_id: "c2", id: "d", published_at: new Date(NOW - 3 * DAY).toISOString(), ours: true, watch: false },
];
const counts = new Map([["a", 12], ["b", 7], ["c", 3], ["d", 0]]);

test("run estimate: one row per creator and a sum of seconds", () => {
  const est = estimateRun(creators, videos, counts, { depth: "all", comments: true, replies: true, now: NOW }, T);
  assert.equal(est.byCreator.length, 2);
  const tt = est.byCreator[0];
  assert.equal(tt.handle, "tt");
  assert.equal(tt.list, 66, "three videos are one scroll: 60 + 6");
  assert.equal(tt.commentVideos, 1, "one candidate: \"b\" and \"c\" are not ours, \"d\" belongs to another creator");
  assert.equal(tt.comments, 10, "12 comments are one page × 10");
  assert.equal(tt.replies, 30, "12 roots × 0.5 × 5");
  assert.equal(tt.commentPages, 1);
  assert.equal(tt.commentRoots, 12);
  assert.equal(tt.done, false);
  const ig = est.byCreator[1];
  assert.equal(ig.comments, 0, "\"d\" has no comments at all");
  assert.equal(est.total, Math.round((tt.total + ig.total) * 10) / 10);
});

test("\"not ours too\" adds candidates, and \"no comments\" removes the step entirely", () => {
  const all = estimateRun(creators, videos, counts, { depth: "all", allVideos: true, now: NOW }, T);
  assert.equal(all.byCreator[0].comments, 30, "depth \"all\" — no window: \"a\", \"b\" and the old \"c\", one page each");
  assert.equal(all.byCreator[0].commentRoots, 22);
  const week = estimateRun(creators, videos, counts, {
    depth: "week", bounds: { since: NOW - 7 * DAY, until: null }, allVideos: true, now: NOW,
  }, T);
  assert.equal(week.byCreator[0].comments, 20, "a week — the sixty-day-old \"c\" is outside the window");
  const none = estimateRun(creators, videos, counts, { depth: "all", comments: false, now: NOW }, T);
  assert.equal(none.byCreator[0].comments, 0);
  assert.equal(none.byCreator[0].total, 66);
});

test("a video's price depends on its comment count, not on the mere fact of a video", () => {
  const big = new Map([["a", 7700], ["b", 7], ["c", 3], ["d", 0]]);
  const small = estimateRun([creators[0]], videos, counts, { depth: "all", direct: true }, DEFAULT_TIMING);
  const large = estimateRun([creators[0]], videos, big, { depth: "all", direct: true }, DEFAULT_TIMING);
  assert.equal(small.byCreator[0].commentVideos, large.byCreator[0].commentVideos, "the same video");
  assert.equal(large.byCreator[0].commentPages, 5);
  assert.ok(large.byCreator[0].comments + large.byCreator[0].replies > 5 * (small.byCreator[0].comments + small.byCreator[0].replies));
});

test("the comment cap from the settings trims both pages and roots", () => {
  const big = new Map([["a", 7700]]);
  const est = estimateRun([creators[0]], [videos[0]], big, { depth: "all", commentsMax: 40 }, T);
  assert.equal(est.byCreator[0].commentPages, 2);
  assert.equal(est.byCreator[0].commentRoots, 40);
});

test("@mrbeast: 67 videos with 7700 comments each — ~35 minutes of comments, not \"under a minute\"", () => {
  const mb = [{ id: "mb", handle: "mrbeast", platform: "tiktok" }];
  const rows = Array.from({ length: 67 }, (_, i) => ({
    creator_id: "mb", id: `m${i}`, published_at: new Date(NOW - i * DAY).toISOString(), ours: false, watch: false,
  }));
  const big = new Map(rows.map((r) => [r.id, 7700]));
  const est = estimateRun(mb, rows, big, { depth: "all", allVideos: true, direct: true, commentsMax: 100 }, DEFAULT_TIMING);
  const one = est.byCreator[0];
  assert.equal(one.commentPages, 67 * 5);
  assert.equal(Math.round(one.comments + one.replies), 2077, "67 × (5 × 0.8 + 100 × 0.3 × 0.9)");
});

test("scope \"ours only\" scrolls to the oldest tracked video, not by depth", () => {
  const tracked = [
    { creator_id: "c1", id: "x", published_at: new Date(NOW - 1 * DAY).toISOString(), ours: false, watch: false },
    ...Array.from({ length: 40 }, (_, i) => ({
      creator_id: "c1",
      id: `y${i}`,
      published_at: new Date(NOW - (2 + i) * DAY).toISOString(),
      ours: i === 39,
      watch: false,
    })),
  ];
  const est = estimateRun([creators[0]], tracked, new Map(), { depth: "week", videos: "ours", now: NOW }, T);
  // Самое старое отслеживаемое — 41-е по счёту: три прокрутки по 20.
  assert.equal(est.byCreator[0].list, 60 + 3 * 6);
});

// --- предварительная оценка: креатор, о котором база не знает ничего -------------------------

test("platform median: an unknown creator is estimated from the known ones, not as zero", () => {
  assert.equal(assumedVideos("tiktok", [10, 40, 400]), 40);
  assert.equal(assumedVideos("tiktok", []), ASSUMED_VIDEOS.tiktok, "no known ones — a constant");
  assert.equal(assumedVideos("instagram", []), ASSUMED_VIDEOS.instagram);
  assert.equal(assumedVideos("darkness", []), ASSUMED_VIDEOS.tiktok, "an unknown platform falls back to TikTok");
});

test("the creator has no videos in the DB — the estimate is rough and by the median, not 0", () => {
  const est = estimateRun([creators[0]], [], new Map(), { depth: "all", now: NOW }, T);
  const one = est.byCreator[0];
  assert.equal(est.rough, true, "the whole run is marked rough");
  assert.equal(one.rough, true);
  assert.equal(one.assumedFrom, "median");
  // Известных креаторов нет — 100 видео константой: 5 прокруток, 100 видео комментариев, у каждого
  // счётчик неизвестен — страница из `ASSUMED_COMMENTS` корней.
  assert.equal(one.list, 60 + 5 * 6);
  assert.equal(one.commentVideos, 100);
  assert.equal(one.commentPages, 100);
  assert.equal(one.comments, 100 * 10);
  assert.equal(one.replies, 100 * ASSUMED_COMMENTS * 0.5 * 5);
});

test("a new TikTok creator: the video count comes from the platform profile, not the median", () => {
  const est = estimateRun([creators[0]], [], new Map(), {
    depth: "all", profileVideos: new Map([["c1", 473]]),
  }, T);
  const one = est.byCreator[0];
  assert.equal(one.assumedFrom, "profile");
  assert.equal(one.assumedVideos, 473);
  assert.equal(one.scrolls, 24, "473 videos at 20 per scroll");
  assert.equal(one.list, 60 + 24 * 6);
  assert.equal(one.commentVideos, 473);
  assert.equal(one.rough, true, "nobody knows the comment counters of his videos anyway");
});

test("a profile for a creator known to the DB does not change the estimate: the DB knows more than the profile", () => {
  const withProfile = estimateRun(creators, videos, counts, { depth: "all", profileVideos: new Map([["c1", 999]]) }, T);
  const without = estimateRun(creators, videos, counts, { depth: "all" }, T);
  assert.deepEqual(withProfile.byCreator, without.byCreator);
});

test("a new creator takes the median of the KNOWN ones on the same platform, not a constant", () => {
  const known = [
    { id: "c1", handle: "tt", platform: "tiktok" },
    { id: "c9", handle: "new", platform: "tiktok" },
  ];
  const rows = Array.from({ length: 40 }, (_, i) => ({
    creator_id: "c1", id: `v${i}`, published_at: new Date(NOW - i * DAY).toISOString(), ours: true, watch: false,
  }));
  const est = estimateRun(known, rows, new Map(), { depth: "all", comments: false, now: NOW }, T);
  // У знакомого 40 видео → медиана площадки 40 → две прокрутки у новичка.
  assert.equal(est.byCreator[1].list, 60 + 2 * 6);
  assert.equal(est.byCreator[1].rough, true);
  assert.equal(est.byCreator[0].rough, false, "a known creator is estimated from the DB, as before");
});

test("scope \"ours only\": a newcomer has no tracked videos — one page, not the median", () => {
  const est = estimateRun([creators[0]], [], new Map(), { depth: "all", videos: "ours", now: NOW }, T);
  assert.equal(est.byCreator[0].list, 66, "there is nothing to scroll for — take the first page");
  assert.equal(est.byCreator[0].commentVideos, 20, "but its twenty videos will go to comments");
});

test("the whole estimate stays rough while at least one creator is rough", () => {
  const est = estimateRun(creators, videos, counts, { depth: "all", now: NOW }, T);
  assert.equal(est.rough, false, "both creators are known to the DB");
});

// --- прогноз и доля ---------------------------------------------------------------------------

test("the remainder is counted per lane, and the total is the longest one", () => {
  const eta = etaSeconds([
    { total: 100, done: 50, elapsedMs: 100_000 },  // вдвое медленнее калибровки: 50×2 = 100
    { total: 100, done: 90, elapsedMs: 90_000 },   // ровно по калибровке: 10
  ]);
  assert.equal(eta, 100, "the run ends when the last lane finishes");
});

test("while a lane is less than a tenth done, the speed comes from the calibration", () => {
  // 5 из 100 за 100 с — отношение 20 с на единицу, но верить ему рано.
  assert.equal(etaSeconds([{ total: 100, done: 5, elapsedMs: 100_000 }]), 95);
});

test("more done than estimated — the forecast is zero, not a negative number", () => {
  assert.equal(etaSeconds([{ total: 100, done: 150, elapsedMs: 10_000 }]), 0);
  assert.equal(etaSeconds([]), 0);
});

// --- фактический темп обхода ------------------------------------------------------------------

test("the median comes from the middle, and garbage and zero do not count", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5, "an even number of samples averages the two middle ones");
  assert.equal(medianOf([5, 0, -2, "no", 7, 6]), 6);
  assert.equal(medianOf([]), null);
  assert.equal(medianOf(null), null);
});

test("an outlier moves the mean but not the median — that is why the median was chosen", () => {
  assert.equal(medianOf([20, 22, 21, 600]), 21.5);
});

test("while there are fewer than three samples, the pace comes from the calibration", () => {
  assert.equal(paceFrom([40, 44], 25), 25, "two is not enough");
  assert.equal(paceFrom([40, 44, 42], 25), 42, "with a third sample we trust the run, not the file");
  assert.equal(paceFrom([], 25), 25);
  assert.equal(paceFrom([40, 44, 42], 25, 5), 25, "the threshold can be raised");
});

test("live prices replace the calibration bucket by bucket, and an untouched bucket stays as it was", () => {
  // Браузер: видео с 12 корнями предсказано в 10 + 12 × 0,5 × 5 = 40 с, а шло 80 — множитель 2.
  const seen = { seconds: 80, pages: 1, roots: 12 };
  const live = livePrices(T, { scroll: [10, 12, 14], browser: [seen, seen, seen] }, { platform: "tiktok" });
  assert.equal(live["page.tiktok"], 12, "the median of the scrolls");
  assert.equal(live["comments.page.browser"], 20);
  assert.equal(live["replies.branch.browser"], 10, "the \"page : branch\" ratio is preserved");
  assert.equal(live["comments.page.direct"], T["comments.page.direct"], "the direct path was not measured");
});

test("direct path: page and branch come from the median of their own samples", () => {
  const live = livePrices(T, { page: [1.4, 1.6, 1.5], branch: [0.8, 1.0, 0.9] });
  assert.equal(live["comments.page.direct"], 1.5);
  assert.equal(live["replies.branch.direct"], 0.9);
  assert.equal(live["comments.page.browser"], T["comments.page.browser"], "the browser path is untouched");
});

test("the branch share is recomputed after the VERY first video — as a run-wide sum, not a median", () => {
  const one = livePrices(T, { share: [{ branches: 30, roots: 100 }] });
  assert.equal(one["replies.share"], 0.3, "one video is enough: calibrating on small ones lies more");
  const two = livePrices(T, { share: [{ branches: 30, roots: 100 }, { branches: 0, roots: 3 }] });
  assert.equal(two["replies.share"], 30 / 103, "a big video weighs by its own roots");
  const none = livePrices(T, { share: [{ branches: 0, roots: 5 }] });
  assert.equal(none["replies.share"], 0, "not a single branch — the share is zero");
});

test("branches were not expanded — neither the branch price nor the share is touched", () => {
  const live = livePrices(T, { page: [2, 2, 2], branch: [9, 9, 9], share: [{ branches: 9, roots: 10 }] }, { replies: false });
  assert.equal(live["comments.page.direct"], 2);
  assert.equal(live["replies.branch.direct"], T["replies.branch.direct"]);
  assert.equal(live["replies.share"], T["replies.share"]);
});

test("the direct and browser paths calibrate separately and do not drag each other", () => {
  const slow = { seconds: 1000, pages: 1, roots: 20 };
  const live = livePrices(DEFAULT_TIMING, { page: [0.1, 0.1, 0.1], browser: [slow, slow, slow] });
  assert.ok(live["comments.page.direct"] < DEFAULT_TIMING["comments.page.direct"], "the direct one got cheaper");
  assert.ok(live["comments.page.browser"] > DEFAULT_TIMING["comments.page.browser"], "the browser one got pricier");
});

// --- пересчёт по факту -------------------------------------------------------------------------

test("revision after the list: the assumption is replaced by the fact and the \"rough\" mark is cleared", () => {
  const before = { handle: "a", list: 90, comments: 2500, replies: 4000, total: 6590, done: false, rough: true };
  const after = reviseAfterList(before, {
    platform: "tiktok", listSeconds: 300, counts: [7700, 3], comments: true, replies: true,
  }, T);
  assert.equal(after.list, 300, "the list cost exactly as long as it ran");
  assert.equal(after.commentPages, 6, "5 pages for the big one and 1 for the small one");
  assert.equal(after.commentRoots, 103);
  assert.equal(after.comments, 6 * 10);
  assert.equal(after.replies, 103 * 0.5 * 5);
  assert.equal(after.total, 300 + 60 + 257.5);
  assert.equal(after.commentVideos, 2);
  assert.equal(after.listDone, true, "the list is done — its remainder is no longer counted");
  assert.equal(after.rough, false);
  assert.equal(after.handle, "a", "the row's other fields are in place");
});

test("a second revision (at the start of comments) does not touch the list", () => {
  const first = reviseAfterList({ list: 90, rough: true }, { platform: "tiktok", listSeconds: 240, counts: [12, 12] }, T);
  const second = reviseAfterList(first, { platform: "tiktok", counts: [12] }, T);
  assert.equal(second.list, 240, "the list duration is not recomputed a second time");
  assert.equal(second.listDone, true);
  assert.equal(second.comments, 10);
  assert.equal(second.total, 240 + 10 + 30);
});

test("no counters given — videos count as having an unknown counter, not as free", () => {
  const after = reviseAfterList({}, { platform: "tiktok", commentVideos: 3 }, T);
  assert.equal(after.commentPages, 3);
  assert.equal(after.commentRoots, 3 * ASSUMED_COMMENTS);
  assert.equal("listDone" in after, false, "no list duration — the list is not done");
});

test("the revision counts by LIVE prices and the cap from the settings", () => {
  const live = livePrices(T, { page: [3, 3, 3] }, { platform: "tiktok" });
  const after = reviseAfterList({ list: 0 }, { platform: "tiktok", listSeconds: 100, counts: [7700], commentsMax: 40, direct: true }, live);
  assert.equal(after.commentPages, 2);
  assert.equal(after.comments, 6, "2 pages at the actual 3 s");
});

test("comments are off — the revision leaves only the list", () => {
  const after = reviseAfterList({}, { platform: "tiktok", listSeconds: 50, counts: [9, 9], comments: false }, T);
  assert.equal(after.total, 50);
  assert.equal(after.commentVideos, 0);
  assert.equal(after.commentPages, 0);
});

// --- остаток креатора из оставшихся единиц ------------------------------------------------------

const fresh = (extra = {}) => ({
  ...estimateCreator({ platform: "tiktok", scrolls: 5, commentVideos: 2, commentPages: 3, commentRoots: 30 }, T),
  done: false,
  ...extra,
});

test("an untouched creator: the remainder equals the estimate", () => {
  const e = fresh();
  assert.equal(remainingOf(e, T, { platform: "tiktok" }), e.total);
  assert.equal(remainingOf(e, T, { platform: "tiktok" }), 195);
});

test("the list is running: the remainder is the plan minus what is counted, but never less than one scroll", () => {
  assert.equal(remainingOf(fresh({ listRunning: true, listPaid: 50 }), T), 40 + 105, "plan 90, counted 50");
  assert.equal(remainingOf(fresh({ listRunning: true, listPaid: 500 }), T), 6 + 105, "the list runs longer than planned — one more scroll");
});

test("the list is done and half the pages are taken — only the unfinished units remain", () => {
  const e = fresh({ listDone: true, commentPagesDone: 1, commentRootsDone: 10 });
  // 2 страницы × 10 + 20 корней × 0,5 × 5.
  assert.equal(remainingOf(e, T), 20 + 50);
  assert.equal(remainingOf(fresh({ done: true }), T), 0, "a finished creator is zero");
  assert.equal(remainingOf(null, T), 0);
});

test("the remainder is recomputed with LIVE prices: expensive videos grow it instead of eating it", () => {
  const e = fresh({ listDone: true });
  const live = livePrices(T, { browser: Array(3).fill({ seconds: 80, pages: 1, roots: 12 }) });
  assert.equal(remainingOf(e, live), 2 * remainingOf(e, T), "the video is twice as expensive — the remainder is twice as large");
});

test("direct path on both platforms (Instagram since 2026-09-16): the remainder uses the cheap prices, and the browser ones when it is off", () => {
  const e = fresh({ listDone: true });
  assert.equal(remainingOf(e, T, { platform: "tiktok", direct: true }), 3 * 1 + 30 * 0.5 * 2);
  assert.equal(remainingOf(e, T, { platform: "instagram", direct: true }), 3 * 1 + 30 * 0.5 * 2);
  assert.equal(remainingOf(e, T, { platform: "instagram", direct: false }), 3 * 10 + 30 * 0.5 * 5);
  assert.equal(remainingOf(e, T, { replies: false }), 30, "without branches only the pages remain");
});

// --- остаток -----------------------------------------------------------------------------------

test("with measurements the remainder is taken as is, the lane speed is no longer guessed", () => {
  // Полоса прошла всего 5 из 100, но цены уже живые: остаток 95 с, а не 95×20.
  assert.equal(remainingSeconds([{ total: 100, done: 5, elapsedMs: 100_000, measured: true }]), 95);
  assert.equal(remainingSeconds([{ total: 100, done: 5, elapsedMs: 100_000 }]), 95, "the one-tenth threshold");
});

test("overrun: a remainder built from leftover units does not collapse to zero the way \"estimate − done\" does", () => {
  // Обход #107: сделано 285 из оценённых 245 — разность давала «почти готово».
  assert.equal(remainingSeconds([{ total: 245, done: 285, measured: true }]), 0, "the old calculation");
  assert.equal(remainingSeconds([{ remaining: 1800, done: 285, measured: true }]), 1800);
  assert.equal(remainingSeconds([{ remaining: 0, total: 999, done: 10 }]), 0, "the remainder is given — `total` is irrelevant");
});

test("without measurements the lane speed comes from \"done + remaining\", not from the old estimate", () => {
  // Сделано 100 с за 200 с по часам — вдвое медленнее: остаток 300 × 2.
  assert.equal(remainingSeconds([{ remaining: 300, done: 100, elapsedMs: 200_000 }]), 600);
  // Прошли меньше десятой части (10 из 410) — скорости верить рано.
  assert.equal(remainingSeconds([{ remaining: 400, done: 10, elapsedMs: 100_000 }]), 400);
});

test("remainder per lane: a measured and an unmeasured lane are each counted their own way", () => {
  const left = remainingSeconds([
    { total: 100, done: 50, elapsedMs: 100_000 },                  // без замеров: 50×2 = 100
    { total: 400, done: 100, elapsedMs: 10_000, measured: true },  // с замерами: 300 как есть
  ]);
  assert.equal(left, 300, "the total is the longest lane");
});

test("percentage: 0–100, and null without an estimate", () => {
  assert.equal(percentDone(42, 100), 42);
  assert.equal(percentDone(150, 100), 100, "the estimate may have been too low");
  assert.equal(percentDone(-5, 100), 0);
  assert.equal(percentDone(5, 0), null);
  assert.equal(percentDone(5, null), null);
});

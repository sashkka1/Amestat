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

test("негодная калибровка заменяется умолчаниями по ключу, а не целиком", () => {
  const t = normalizeTiming({ "page.tiktok": 12, "comments.page.browser": "нет", extra: 5 });
  assert.equal(t["page.tiktok"], 12, "годное значение остаётся");
  assert.equal(t["comments.page.browser"], DEFAULT_TIMING["comments.page.browser"]);
  assert.equal(t["list.tiktok"], DEFAULT_TIMING["list.tiktok"]);
  assert.equal("extra" in t, false, "лишние ключи в расчёт не идут");
});

test("доля веток — не секунды: ноль законен, больше единицы режется, мусор — умолчание", () => {
  assert.equal(normalizeTiming({ "replies.share": 0 })["replies.share"], 0, "веток не было вовсе");
  assert.equal(normalizeTiming({ "replies.share": 3 })["replies.share"], 1);
  assert.equal(normalizeTiming({ "replies.share": -1 })["replies.share"], DEFAULT_TIMING["replies.share"]);
  assert.equal(normalizeTiming({ "replies.share": "" })["replies.share"], DEFAULT_TIMING["replies.share"]);
});

test("ноль и отрицательное — тоже мусор: цена шага не бывает нулевой", () => {
  const t = normalizeTiming({ "list.tiktok": 0, "page.tiktok": -3 });
  assert.equal(t["list.tiktok"], DEFAULT_TIMING["list.tiktok"]);
  assert.equal(t["page.tiktok"], DEFAULT_TIMING["page.tiktok"]);
});

test("скользящее среднее тянет старое на альфу, а первое измерение берётся как есть", () => {
  assert.equal(foldEma(10, 20, 0.3), 13);
  assert.equal(foldEma(null, 20, 0.3), 20, "прошлого нет — верим измерению");
  assert.equal(foldEma(10, null, 0.3), 10, "измерения нет — остаётся прежнее");
});

// --- калибровка шага списка ----------------------------------------------------------------

test("шаг списка вдвое дольше ожидаемого поднимает обе цены, сохраняя их отношение", () => {
  const before = { "list.tiktok": 60, "page.tiktok": 6 };
  // 60 + 5×6 = 90 предсказанных, факт 180 → множитель 2.
  const after = calibrateList(before, "tiktok", 180, 5, 1);
  assert.equal(after["list.tiktok"], 120);
  assert.equal(after["page.tiktok"], 12);
  assert.equal(after["list.instagram"], DEFAULT_TIMING["list.instagram"], "чужая площадка не двигается");
});

test("прокруток не было — вся секунда идёт в базу, цена прокрутки не трогается", () => {
  const after = calibrateList({ "list.tiktok": 60, "page.tiktok": 6 }, "tiktok", 100, 0, 1);
  assert.equal(after["list.tiktok"], 100);
  assert.equal(after["page.tiktok"], 6);
});

test("альфа сглаживает: 0.3 от разницы, а не вся разница", () => {
  const after = calibrateList({ "list.instagram": 20, "page.instagram": 5 }, "instagram", 90, 2, 0.3);
  // предсказано 30, факт 90 → множитель 3; база: 20×0.7 + 60×0.3 = 32.
  assert.equal(Math.round(after["list.instagram"] * 10) / 10, 32);
  assert.equal(Math.round(after["page.instagram"] * 10) / 10, 8);
});

test("нулевая и отрицательная длительность шага калибровку не портят", () => {
  const before = normalizeTiming({});
  assert.deepEqual(calibrateList(before, "tiktok", 0, 3), before);
  assert.deepEqual(calibrateList(before, "tiktok", -5, 3), before);
});

// --- калибровка шага комментариев ----------------------------------------------------------

const B = { "comments.page.browser": 10, "replies.branch.browser": 5, "replies.share": 0.5 };

test("браузер без веток: всё время шага — цена страницы", () => {
  const after = calibrateComments(B, { seconds: 200, pages: 10, roots: 50 }, { replies: false, alpha: 1 });
  assert.equal(after["comments.page.browser"], 20);
  assert.equal(after["replies.branch.browser"], 5, "ветки не раскрывались — их цена неизвестна");
});

test("браузер с ветками: измерение накрывает обе цены и двигает их одним множителем", () => {
  // 4 страницы × 10 + 20 корней × 0,5 × 5 = 90 предсказанных, факт 180 → множитель 2.
  const after = calibrateComments(B, { seconds: 180, pages: 4, roots: 20 }, { alpha: 1 });
  assert.equal(after["comments.page.browser"], 20);
  assert.equal(after["replies.branch.browser"], 10);
});

test("прямой путь: корни, ветки и доля калибруются каждый своим замером", () => {
  // Обход #107: сотня корней — 5 страниц оценки за 7,5 с, 30 веток за 27 с.
  const after = calibrateComments(DEFAULT_TIMING, { pages: 5, roots: 100, pageSeconds: 7.5, branchSeconds: 27, branches: 30 }, { direct: true, alpha: 1 });
  assert.equal(after["comments.page.direct"], 1.5, "секунды корней ÷ страницы оценки");
  assert.equal(after["replies.branch.direct"], 0.9);
  assert.equal(after["replies.share"], 0.3, "30 веток на 100 корней");
  assert.equal(after["comments.page.browser"], DEFAULT_TIMING["comments.page.browser"], "браузерный путь не тронут");
});

test("ни одной ветки — доля честно идёт вниз, а не остаётся прежней", () => {
  const after = calibrateComments({ "replies.share": 0.3 }, { pages: 1, roots: 3, pageSeconds: 0.4, branchSeconds: 0, branches: 0 }, { direct: true, alpha: 0.5 });
  assert.equal(after["replies.share"], 0.15);
});

test("шаг комментариев не обошёл ни одной страницы — калибровать нечем", () => {
  const before = normalizeTiming({});
  assert.deepEqual(calibrateComments(before, { seconds: 300, pages: 0 }), before);
  assert.deepEqual(calibrateComments(before, { pages: 3 }), before, "ни секунд, ни разбивки");
});

// --- единицы шага комментариев: страницы и корни ----------------------------------------------

test("видео считается страницами по 20 из счётчика, срезанного потолком", () => {
  // @mrbeast: 7700 комментариев, потолок 100 → 100 корней → 5 страниц.
  assert.deepEqual(videoUnits(7700, 100), { pages: 5, roots: 100 });
  assert.deepEqual(videoUnits(3, 100), { pages: 1, roots: 3 }, "маленькое видео — одна страница");
  assert.deepEqual(videoUnits(45, 100), { pages: 3, roots: 45 });
  assert.deepEqual(videoUnits(500, 300), { pages: 15, roots: 300 }, "потолок свой");
  assert.deepEqual(videoUnits(7700), { pages: 5, roots: 100 }, "потолок по умолчанию — 100");
});

test("счётчик неизвестен — одна полная страница, а не ноль", () => {
  assert.deepEqual(videoUnits(null), { pages: 1, roots: ASSUMED_COMMENTS });
  assert.deepEqual(videoUnits(0), { pages: 1, roots: ASSUMED_COMMENTS });
});

test("единицы набора видео — сумма по видео", () => {
  assert.deepEqual(commentUnits([7700, 3, 45], 100), { videos: 3, pages: 9, roots: 148 });
  assert.deepEqual(commentUnits([]), { videos: 0, pages: 0, roots: 0 });
});

test("@mrbeast: видео с 7700 комментариями — 31 с, а не 2,2 с, и 67 таких видео — 35 минут", () => {
  const one = commentSeconds(videoUnits(7700, 100), DEFAULT_TIMING, { direct: true });
  // 5 страниц × 0,8 + 100 корней × 0,3 × 0,9 = 4 + 27.
  assert.equal(Math.round(one.comments * 10) / 10, 4);
  assert.equal(Math.round(one.replies * 10) / 10, 27);
  const run = commentSeconds(commentUnits(Array(67).fill(7700), 100), DEFAULT_TIMING, { direct: true });
  assert.equal(Math.round(run.comments + run.replies), 2077);
  const noBranches = commentSeconds(videoUnits(7700, 100), DEFAULT_TIMING, { direct: true, replies: false });
  assert.equal(noBranches.replies, 0, "ветки не раскрываются — их нет и в оценке");
});

// --- прокрутки -----------------------------------------------------------------------------

test("глубина «всё»: прокрутки считаются по всем известным видео креатора", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "all", videosTotal: 100 }), 5, "20 на прокрутку");
  assert.equal(listScrolls({ platform: "instagram", depth: "all", videosTotal: 100 }), 9, "12 на прокрутку");
  assert.equal(PER_SCROLL.tiktok, 20);
});

test("первая страница приезжает всегда: меньше одной прокрутки не бывает", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "week", inDepth: 0 }), 1);
  assert.equal(listScrolls({ platform: "tiktok", mode: "ours", toTracked: 0 }), 1, "отслеживаемых нет — первая страница");
});

test("глубина «неделя» считает только видео из недели, а не всю историю", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "week", videosTotal: 500, inDepth: 21 }), 2);
});

test("потолок видео режет прокрутки, но при охвате «только наши» — нет", () => {
  assert.equal(listScrolls({ platform: "tiktok", depth: "all", videosTotal: 500, maxVideos: 50 }), 3);
  assert.equal(
    listScrolls({ platform: "tiktok", mode: "ours", toTracked: 200, maxVideos: 20 }),
    10,
    "за отслеживаемыми листаем сверх потолка — так решает scope.mjs",
  );
});

test("«только наши»: листаем до самого старого отслеживаемого, глубина не при чём", () => {
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

test("оценка креатора: база + прокрутки + страницы + ветки", () => {
  const e = estimateCreator({ handle: "a", platform: "tiktok", scrolls: 5, commentVideos: 2, commentPages: 3, commentRoots: 30 }, T);
  assert.equal(e.list, 90, "60 + 5×6");
  assert.equal(e.comments, 30, "3 страницы × 10");
  assert.equal(e.replies, 75, "30 корней × 0,5 × 5");
  assert.equal(e.total, 195);
  assert.equal(e.scrolls, 5, "единицы уходят в строку — по ним считается остаток");
  assert.equal(e.commentPages, 3);
  assert.equal(e.commentRoots, 30);
});

test("единиц не дали — каждое видео считается видео с неизвестным счётчиком", () => {
  const e = estimateCreator({ platform: "tiktok", scrolls: 1, commentVideos: 2 }, T);
  assert.equal(e.commentPages, 2);
  assert.equal(e.commentRoots, 2 * ASSUMED_COMMENTS);
});

test("комментарии выключены — ни текстов, ни веток в оценке", () => {
  const e = estimateCreator({ platform: "tiktok", scrolls: 1, commentVideos: 9, commentPages: 9, commentRoots: 90, comments: false }, T);
  assert.equal(e.comments, 0);
  assert.equal(e.replies, 0);
  assert.equal(e.total, 66);
  assert.equal(e.commentPages, 0);
});

test("ветки выключены — тексты остаются, ветки нет", () => {
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

test("кандидат — свежее, с комментариями и наше", () => {
  assert.equal(commentCandidate(row(1), 5, WIN), true);
  assert.equal(commentCandidate(row(1), 0, WIN), false, "комментариев нет вовсе");
  assert.equal(commentCandidate(row(30), 5, WIN), false, "старое");
  assert.equal(commentCandidate({ ...row(1), published_at: null }, 5, WIN), false);
});

test("чужое и жёлтое текстов не получают, пока не попросили «и не наши»", () => {
  const alien = row(1, { ours: false });
  const yellow = row(1, { ours: false, watch: true });
  assert.equal(commentCandidate(alien, 5, WIN), false);
  assert.equal(commentCandidate(yellow, 5, WIN), false, "«смотрим историю» — это счётчики");
  assert.equal(commentCandidate(alien, 5, { ...WIN, allVideos: true }), true);
});

test("верхняя граница периода отсекает свежее", () => {
  const win = { since: NOW - 20 * DAY, until: NOW - 10 * DAY };
  assert.equal(commentCandidate(row(1), 5, win), false);
  assert.equal(commentCandidate(row(15), 5, win), true);
});

test("окно комментариев равно глубине обхода: неделя, месяц, период", () => {
  const week = commentsWindow({ bounds: { since: NOW - 7 * DAY, until: null } });
  assert.equal(week.since, NOW - 7 * DAY);
  assert.equal(week.until, null);
  const month = commentsWindow({ bounds: { since: NOW - 30 * DAY, until: null } });
  assert.equal(month.since, NOW - 30 * DAY, "месячный обход снимает комментарии за месяц");
  const ranged = commentsWindow({ bounds: { since: NOW - 20 * DAY, until: NOW - 10 * DAY } });
  assert.equal(ranged.since, NOW - 20 * DAY);
  assert.equal(ranged.until, NOW - 10 * DAY);
});

test("глубина «всё» — окна нет вовсе, ни своих дней, ни границ", () => {
  const all = commentsWindow({ bounds: { since: null, until: null } });
  assert.equal(all.since, null);
  assert.equal(all.until, null);
  assert.deepEqual(commentsWindow(), { since: null, until: null }, "границ не дали вовсе");
});

test("при глубине «всё» кандидатом становится и видео без даты", () => {
  const none = { since: null, until: null };
  assert.equal(commentCandidate(row(400), 5, none), true, "старое — но глубина «всё»");
  assert.equal(commentCandidate({ ...row(1), published_at: null }, 5, none), true);
  assert.equal(commentCandidate({ ...row(1), published_at: null }, 0, none), false, "комментариев нет");
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

test("оценка обхода: по строке на креатора и сумма секунд", () => {
  const est = estimateRun(creators, videos, counts, { depth: "all", comments: true, replies: true, now: NOW }, T);
  assert.equal(est.byCreator.length, 2);
  const tt = est.byCreator[0];
  assert.equal(tt.handle, "tt");
  assert.equal(tt.list, 66, "три видео — одна прокрутка: 60 + 6");
  assert.equal(tt.commentVideos, 1, "кандидат один: «b» и «c» чужие, «d» чужого креатора");
  assert.equal(tt.comments, 10, "12 комментариев — одна страница × 10");
  assert.equal(tt.replies, 30, "12 корней × 0,5 × 5");
  assert.equal(tt.commentPages, 1);
  assert.equal(tt.commentRoots, 12);
  assert.equal(tt.done, false);
  const ig = est.byCreator[1];
  assert.equal(ig.comments, 0, "у «d» комментариев нет вовсе");
  assert.equal(est.total, Math.round((tt.total + ig.total) * 10) / 10);
});

test("«и не наши видео» добавляет кандидатов, а «без комментариев» убирает шаг целиком", () => {
  const all = estimateRun(creators, videos, counts, { depth: "all", allVideos: true, now: NOW }, T);
  assert.equal(all.byCreator[0].comments, 30, "глубина «всё» — окна нет: «a», «b» и старое «c», по странице");
  assert.equal(all.byCreator[0].commentRoots, 22);
  const week = estimateRun(creators, videos, counts, {
    depth: "week", bounds: { since: NOW - 7 * DAY, until: null }, allVideos: true, now: NOW,
  }, T);
  assert.equal(week.byCreator[0].comments, 20, "неделя — «c» шестидесятидневное за окном");
  const none = estimateRun(creators, videos, counts, { depth: "all", comments: false, now: NOW }, T);
  assert.equal(none.byCreator[0].comments, 0);
  assert.equal(none.byCreator[0].total, 66);
});

test("цена видео зависит от числа его комментариев, а не от самого факта видео", () => {
  const big = new Map([["a", 7700], ["b", 7], ["c", 3], ["d", 0]]);
  const small = estimateRun([creators[0]], videos, counts, { depth: "all", direct: true }, DEFAULT_TIMING);
  const large = estimateRun([creators[0]], videos, big, { depth: "all", direct: true }, DEFAULT_TIMING);
  assert.equal(small.byCreator[0].commentVideos, large.byCreator[0].commentVideos, "видео то же самое");
  assert.equal(large.byCreator[0].commentPages, 5);
  assert.ok(large.byCreator[0].comments + large.byCreator[0].replies > 5 * (small.byCreator[0].comments + small.byCreator[0].replies));
});

test("потолок комментариев из настроек режет и страницы, и корни", () => {
  const big = new Map([["a", 7700]]);
  const est = estimateRun([creators[0]], [videos[0]], big, { depth: "all", commentsMax: 40 }, T);
  assert.equal(est.byCreator[0].commentPages, 2);
  assert.equal(est.byCreator[0].commentRoots, 40);
});

test("@mrbeast: 67 видео по 7700 комментариев — ~35 минут комментариев, а не «меньше минуты»", () => {
  const mb = [{ id: "mb", handle: "mrbeast", platform: "tiktok" }];
  const rows = Array.from({ length: 67 }, (_, i) => ({
    creator_id: "mb", id: `m${i}`, published_at: new Date(NOW - i * DAY).toISOString(), ours: false, watch: false,
  }));
  const big = new Map(rows.map((r) => [r.id, 7700]));
  const est = estimateRun(mb, rows, big, { depth: "all", allVideos: true, direct: true, commentsMax: 100 }, DEFAULT_TIMING);
  const one = est.byCreator[0];
  assert.equal(one.commentPages, 67 * 5);
  assert.equal(Math.round(one.comments + one.replies), 2077, "67 × (5 × 0,8 + 100 × 0,3 × 0,9)");
});

test("охват «только наши» листает до самого старого отслеживаемого, а не по глубине", () => {
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

test("медиана площадки: незнакомый креатор считается по известным, а не в ноль", () => {
  assert.equal(assumedVideos("tiktok", [10, 40, 400]), 40);
  assert.equal(assumedVideos("tiktok", []), ASSUMED_VIDEOS.tiktok, "известных нет — константа");
  assert.equal(assumedVideos("instagram", []), ASSUMED_VIDEOS.instagram);
  assert.equal(assumedVideos("тьма", []), ASSUMED_VIDEOS.tiktok, "чужая площадка — TikTok");
});

test("креатора нет в базе ни одним видео — оценка предварительная и по медиане, а не 0", () => {
  const est = estimateRun([creators[0]], [], new Map(), { depth: "all", now: NOW }, T);
  const one = est.byCreator[0];
  assert.equal(est.rough, true, "весь обход помечен предварительным");
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

test("новый креатор TikTok: число видео из профиля площадки, а не медиана", () => {
  const est = estimateRun([creators[0]], [], new Map(), {
    depth: "all", profileVideos: new Map([["c1", 473]]),
  }, T);
  const one = est.byCreator[0];
  assert.equal(one.assumedFrom, "profile");
  assert.equal(one.assumedVideos, 473);
  assert.equal(one.scrolls, 24, "473 видео по 20 на прокрутку");
  assert.equal(one.list, 60 + 24 * 6);
  assert.equal(one.commentVideos, 473);
  assert.equal(one.rough, true, "счётчиков комментариев его видео всё равно никто не знает");
});

test("профиль известного базе креатора оценку не меняет: база знает больше профиля", () => {
  const withProfile = estimateRun(creators, videos, counts, { depth: "all", profileVideos: new Map([["c1", 999]]) }, T);
  const without = estimateRun(creators, videos, counts, { depth: "all" }, T);
  assert.deepEqual(withProfile.byCreator, without.byCreator);
});

test("новый креатор берёт медиану ЗНАКОМЫХ той же площадки, а не константу", () => {
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
  assert.equal(est.byCreator[0].rough, false, "знакомый считается по базе, как и раньше");
});

test("охват «только наши»: у новичка отслеживаемых нет — одна страница, а не медиана", () => {
  const est = estimateRun([creators[0]], [], new Map(), { depth: "all", videos: "ours", now: NOW }, T);
  assert.equal(est.byCreator[0].list, 66, "листать не за чем — берём первую страницу");
  assert.equal(est.byCreator[0].commentVideos, 20, "но её двадцать видео пойдут на комментарии");
});

test("вся оценка предварительна, пока предварителен хоть один креатор", () => {
  const est = estimateRun(creators, videos, counts, { depth: "all", now: NOW }, T);
  assert.equal(est.rough, false, "оба креатора известны базе");
});

// --- прогноз и доля ---------------------------------------------------------------------------

test("остаток считается по полосам, итог — самая долгая", () => {
  const eta = etaSeconds([
    { total: 100, done: 50, elapsedMs: 100_000 },  // вдвое медленнее калибровки: 50×2 = 100
    { total: 100, done: 90, elapsedMs: 90_000 },   // ровно по калибровке: 10
  ]);
  assert.equal(eta, 100, "обход кончится, когда закончит последняя полоса");
});

test("пока полоса прошла меньше десятой части, скорость берётся по калибровке", () => {
  // 5 из 100 за 100 с — отношение 20 с на единицу, но верить ему рано.
  assert.equal(etaSeconds([{ total: 100, done: 5, elapsedMs: 100_000 }]), 95);
});

test("сделанного больше оценки — прогноз ноль, а не отрицательное число", () => {
  assert.equal(etaSeconds([{ total: 100, done: 150, elapsedMs: 10_000 }]), 0);
  assert.equal(etaSeconds([]), 0);
});

// --- фактический темп обхода ------------------------------------------------------------------

test("медиана берётся из середины, а мусор и ноль в счёт не идут", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5, "чётное число замеров — среднее двух средних");
  assert.equal(medianOf([5, 0, -2, "нет", 7, 6]), 6);
  assert.equal(medianOf([]), null);
  assert.equal(medianOf(null), null);
});

test("выброс двигает среднее, но не медиану — ради этого она и взята", () => {
  assert.equal(medianOf([20, 22, 21, 600]), 21.5);
});

test("пока замеров меньше трёх, темп берётся из калибровки", () => {
  assert.equal(paceFrom([40, 44], 25), 25, "двух мало");
  assert.equal(paceFrom([40, 44, 42], 25), 42, "третий замер — верим обходу, а не файлу");
  assert.equal(paceFrom([], 25), 25);
  assert.equal(paceFrom([40, 44, 42], 25, 5), 25, "порог можно поднять");
});

test("живые цены заменяют калибровку по вёдрам, а нетронутое ведро остаётся прежним", () => {
  // Браузер: видео с 12 корнями предсказано в 10 + 12 × 0,5 × 5 = 40 с, а шло 80 — множитель 2.
  const seen = { seconds: 80, pages: 1, roots: 12 };
  const live = livePrices(T, { scroll: [10, 12, 14], browser: [seen, seen, seen] }, { platform: "tiktok" });
  assert.equal(live["page.tiktok"], 12, "медиана прокруток");
  assert.equal(live["comments.page.browser"], 20);
  assert.equal(live["replies.branch.browser"], 10, "пропорция «страница : ветка» сохранена");
  assert.equal(live["comments.page.direct"], T["comments.page.direct"], "прямой путь не замерялся");
});

test("прямой путь: страница и ветка — медианой своих замеров", () => {
  const live = livePrices(T, { page: [1.4, 1.6, 1.5], branch: [0.8, 1.0, 0.9] });
  assert.equal(live["comments.page.direct"], 1.5);
  assert.equal(live["replies.branch.direct"], 0.9);
  assert.equal(live["comments.page.browser"], T["comments.page.browser"], "браузер не тронут");
});

test("доля веток пересчитывается после ПЕРВОГО же видео — суммой по обходу, а не медианой", () => {
  const one = livePrices(T, { share: [{ branches: 30, roots: 100 }] });
  assert.equal(one["replies.share"], 0.3, "одного видео хватает: калибровка по маленьким врёт сильнее");
  const two = livePrices(T, { share: [{ branches: 30, roots: 100 }, { branches: 0, roots: 3 }] });
  assert.equal(two["replies.share"], 30 / 103, "крупное видео весит по своим корням");
  const none = livePrices(T, { share: [{ branches: 0, roots: 5 }] });
  assert.equal(none["replies.share"], 0, "ни одной ветки — доля ноль");
});

test("ветки не раскрывались — ни цена ветки, ни доля не трогаются", () => {
  const live = livePrices(T, { page: [2, 2, 2], branch: [9, 9, 9], share: [{ branches: 9, roots: 10 }] }, { replies: false });
  assert.equal(live["comments.page.direct"], 2);
  assert.equal(live["replies.branch.direct"], T["replies.branch.direct"]);
  assert.equal(live["replies.share"], T["replies.share"]);
});

test("прямой путь и браузерный калибруются порознь и не тянут друг друга", () => {
  const slow = { seconds: 1000, pages: 1, roots: 20 };
  const live = livePrices(DEFAULT_TIMING, { page: [0.1, 0.1, 0.1], browser: [slow, slow, slow] });
  assert.ok(live["comments.page.direct"] < DEFAULT_TIMING["comments.page.direct"], "прямой стал дешевле");
  assert.ok(live["comments.page.browser"] > DEFAULT_TIMING["comments.page.browser"], "браузерный — дороже");
});

// --- пересчёт по факту -------------------------------------------------------------------------

test("пересчёт после списка: предположение заменяется фактом и метка «предварительно» снимается", () => {
  const before = { handle: "a", list: 90, comments: 2500, replies: 4000, total: 6590, done: false, rough: true };
  const after = reviseAfterList(before, {
    platform: "tiktok", listSeconds: 300, counts: [7700, 3], comments: true, replies: true,
  }, T);
  assert.equal(after.list, 300, "список стоил ровно столько, сколько шёл");
  assert.equal(after.commentPages, 6, "5 страниц у крупного и 1 у маленького");
  assert.equal(after.commentRoots, 103);
  assert.equal(after.comments, 6 * 10);
  assert.equal(after.replies, 103 * 0.5 * 5);
  assert.equal(after.total, 300 + 60 + 257.5);
  assert.equal(after.commentVideos, 2);
  assert.equal(after.listDone, true, "список пройден — его остаток больше не считается");
  assert.equal(after.rough, false);
  assert.equal(after.handle, "a", "остальные поля строки на месте");
});

test("второй пересчёт (в начале комментариев) списка не трогает", () => {
  const first = reviseAfterList({ list: 90, rough: true }, { platform: "tiktok", listSeconds: 240, counts: [12, 12] }, T);
  const second = reviseAfterList(first, { platform: "tiktok", counts: [12] }, T);
  assert.equal(second.list, 240, "длительность списка не пересчитывается второй раз");
  assert.equal(second.listDone, true);
  assert.equal(second.comments, 10);
  assert.equal(second.total, 240 + 10 + 30);
});

test("счётчиков не дали — видео считаются с неизвестным счётчиком, а не бесплатными", () => {
  const after = reviseAfterList({}, { platform: "tiktok", commentVideos: 3 }, T);
  assert.equal(after.commentPages, 3);
  assert.equal(after.commentRoots, 3 * ASSUMED_COMMENTS);
  assert.equal("listDone" in after, false, "длительности списка нет — список не пройден");
});

test("пересчёт считает по ЖИВЫМ ценам и потолку из настроек", () => {
  const live = livePrices(T, { page: [3, 3, 3] }, { platform: "tiktok" });
  const after = reviseAfterList({ list: 0 }, { platform: "tiktok", listSeconds: 100, counts: [7700], commentsMax: 40, direct: true }, live);
  assert.equal(after.commentPages, 2);
  assert.equal(after.comments, 6, "2 страницы по фактическим 3 с");
});

test("комментарии выключены — пересчёт оставляет один список", () => {
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

test("нетронутый креатор: остаток равен его оценке", () => {
  const e = fresh();
  assert.equal(remainingOf(e, T, { platform: "tiktok" }), e.total);
  assert.equal(remainingOf(e, T, { platform: "tiktok" }), 195);
});

test("список идёт: остаток — план без засчитанного, но не меньше одной прокрутки", () => {
  assert.equal(remainingOf(fresh({ listRunning: true, listPaid: 50 }), T), 40 + 105, "план 90, засчитано 50");
  assert.equal(remainingOf(fresh({ listRunning: true, listPaid: 500 }), T), 6 + 105, "список дольше плана — ещё прокрутка");
});

test("список пройден, половина страниц снята — в остатке только непройденные единицы", () => {
  const e = fresh({ listDone: true, commentPagesDone: 1, commentRootsDone: 10 });
  // 2 страницы × 10 + 20 корней × 0,5 × 5.
  assert.equal(remainingOf(e, T), 20 + 50);
  assert.equal(remainingOf(fresh({ done: true }), T), 0, "пройденный креатор — ноль");
  assert.equal(remainingOf(null, T), 0);
});

test("остаток пересчитывается ЖИВЫМИ ценами: дорогие видео растят его, а не съедают", () => {
  const e = fresh({ listDone: true });
  const live = livePrices(T, { browser: Array(3).fill({ seconds: 80, pages: 1, roots: 12 }) });
  assert.equal(remainingOf(e, live), 2 * remainingOf(e, T), "видео вдвое дороже — остаток вдвое больше");
});

test("прямой путь — только у TikTok: у Instagram остаток по браузерным ценам", () => {
  const e = fresh({ listDone: true });
  assert.equal(remainingOf(e, T, { platform: "tiktok", direct: true }), 3 * 1 + 30 * 0.5 * 2);
  assert.equal(remainingOf(e, T, { platform: "instagram", direct: true }), 3 * 10 + 30 * 0.5 * 5);
  assert.equal(remainingOf(e, T, { replies: false }), 30, "без веток — одни страницы");
});

// --- остаток -----------------------------------------------------------------------------------

test("есть замеры — остаток берётся как есть, скорость полосы больше не гадается", () => {
  // Полоса прошла всего 5 из 100, но цены уже живые: остаток 95 с, а не 95×20.
  assert.equal(remainingSeconds([{ total: 100, done: 5, elapsedMs: 100_000, measured: true }]), 95);
  assert.equal(remainingSeconds([{ total: 100, done: 5, elapsedMs: 100_000 }]), 95, "порог десятой части");
});

test("перерасход: остаток из оставшихся единиц не схлопывается в ноль, как «оценка − сделано»", () => {
  // Обход #107: сделано 285 из оценённых 245 — разность давала «почти готово».
  assert.equal(remainingSeconds([{ total: 245, done: 285, measured: true }]), 0, "прежний расчёт");
  assert.equal(remainingSeconds([{ remaining: 1800, done: 285, measured: true }]), 1800);
  assert.equal(remainingSeconds([{ remaining: 0, total: 999, done: 10 }]), 0, "остаток дан — `total` не при чём");
});

test("без замеров скорость полосы берётся от «сделано + остаток», а не от старой оценки", () => {
  // Сделано 100 с за 200 с по часам — вдвое медленнее: остаток 300 × 2.
  assert.equal(remainingSeconds([{ remaining: 300, done: 100, elapsedMs: 200_000 }]), 600);
  // Прошли меньше десятой части (10 из 410) — скорости верить рано.
  assert.equal(remainingSeconds([{ remaining: 400, done: 10, elapsedMs: 100_000 }]), 400);
});

test("остаток по полосам: замерянная и незамерянная считаются каждая по-своему", () => {
  const left = remainingSeconds([
    { total: 100, done: 50, elapsedMs: 100_000 },                  // без замеров: 50×2 = 100
    { total: 400, done: 100, elapsedMs: 10_000, measured: true },  // с замерами: 300 как есть
  ]);
  assert.equal(left, 300, "итог — самая долгая полоса");
});

test("доля: 0–100, а без оценки — null", () => {
  assert.equal(percentDone(42, 100), 42);
  assert.equal(percentDone(150, 100), 100, "оценка могла оказаться заниженной");
  assert.equal(percentDone(-5, 100), 0);
  assert.equal(percentDone(5, 0), null);
  assert.equal(percentDone(5, null), null);
});

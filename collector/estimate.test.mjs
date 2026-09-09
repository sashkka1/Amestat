// Оценка объёма обхода и калибровка (`estimate.mjs`). Ни базы, ни браузера, ни файлов —
// только расчёты на выдуманных строках.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIMING,
  PER_SCROLL,
  calibrateComments,
  calibrateList,
  commentCandidate,
  commentsWindow,
  estimateCreator,
  estimateRun,
  etaSeconds,
  foldEma,
  listScrolls,
  normalizeTiming,
  percentDone,
} from "./estimate.mjs";

// --- калибровка: приведение и среднее ------------------------------------------------------

test("негодная калибровка заменяется умолчаниями по ключу, а не целиком", () => {
  const t = normalizeTiming({ "page.tiktok": 12, "comments.video": "нет", extra: 5 });
  assert.equal(t["page.tiktok"], 12, "годное значение остаётся");
  assert.equal(t["comments.video"], DEFAULT_TIMING["comments.video"]);
  assert.equal(t["list.tiktok"], DEFAULT_TIMING["list.tiktok"]);
  assert.equal("extra" in t, false, "лишние ключи в расчёт не идут");
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

test("без веток измеряется чистая цена видео", () => {
  const after = calibrateComments({ "comments.video": 25, "replies.video": 40 }, 200, 4, false, 1);
  assert.equal(after["comments.video"], 50);
  assert.equal(after["replies.video"], 40, "ветки не раскрывались — их цена неизвестна");
});

test("с ветками измерение накрывает обе цены и двигает их одним множителем", () => {
  // 10 видео за 1300 с → 130 на видео при предсказанных 65 → множитель 2.
  const after = calibrateComments({ "comments.video": 25, "replies.video": 40 }, 1300, 10, true, 1);
  assert.equal(after["comments.video"], 50);
  assert.equal(after["replies.video"], 80);
});

test("шаг комментариев не обошёл ни одного видео — калибровать нечем", () => {
  const before = normalizeTiming({});
  assert.deepEqual(calibrateComments(before, 300, 0, true), before);
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
  "comments.video": 25, "replies.video": 40,
};

test("оценка креатора: база + прокрутки + комментарии + ветки", () => {
  const e = estimateCreator({ handle: "a", platform: "tiktok", scrolls: 5, commentVideos: 4 }, T);
  assert.equal(e.list, 90, "60 + 5×6");
  assert.equal(e.comments, 100);
  assert.equal(e.replies, 160);
  assert.equal(e.total, 350);
});

test("комментарии выключены — ни текстов, ни веток в оценке", () => {
  const e = estimateCreator({ platform: "tiktok", scrolls: 1, commentVideos: 9, comments: false }, T);
  assert.equal(e.comments, 0);
  assert.equal(e.replies, 0);
  assert.equal(e.total, 66);
});

test("ветки выключены — тексты остаются, ветки нет", () => {
  const e = estimateCreator({ platform: "instagram", scrolls: 2, commentVideos: 3, replies: false }, T);
  assert.equal(e.list, 30);
  assert.equal(e.comments, 75);
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
  assert.equal(tt.comments, 25, "кандидат один: «b» и «c» чужие, «d» чужого креатора");
  assert.equal(tt.replies, 40);
  assert.equal(tt.done, false);
  const ig = est.byCreator[1];
  assert.equal(ig.comments, 0, "у «d» комментариев нет вовсе");
  assert.equal(est.total, Math.round((tt.total + ig.total) * 10) / 10);
});

test("«и не наши видео» добавляет кандидатов, а «без комментариев» убирает шаг целиком", () => {
  const all = estimateRun(creators, videos, counts, { depth: "all", allVideos: true, now: NOW }, T);
  assert.equal(all.byCreator[0].comments, 75, "глубина «всё» — окна нет: «a», «b» и старое «c»");
  const week = estimateRun(creators, videos, counts, {
    depth: "week", bounds: { since: NOW - 7 * DAY, until: null }, allVideos: true, now: NOW,
  }, T);
  assert.equal(week.byCreator[0].comments, 50, "неделя — «c» шестидесятидневное за окном");
  const none = estimateRun(creators, videos, counts, { depth: "all", comments: false, now: NOW }, T);
  assert.equal(none.byCreator[0].comments, 0);
  assert.equal(none.byCreator[0].total, 66);
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

test("креатора нет в базе ни одним видео — всё равно одна прокрутка, а не ноль работы", () => {
  const est = estimateRun([creators[0]], [], new Map(), { depth: "all", now: NOW }, T);
  assert.equal(est.byCreator[0].list, 66);
  assert.equal(est.total, 66);
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

test("доля: 0–100, а без оценки — null", () => {
  assert.equal(percentDone(42, 100), 42);
  assert.equal(percentDone(150, 100), 100, "оценка могла оказаться заниженной");
  assert.equal(percentDone(-5, 100), 0);
  assert.equal(percentDone(5, 0), null);
  assert.equal(percentDone(5, null), null);
});

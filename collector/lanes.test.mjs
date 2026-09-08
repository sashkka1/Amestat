// Чистые куски правки 2026-09-08, вечер: две полосы, склейка галочек просьб и решение
// «это видео за комментариями не открываем».
//
// Браузера здесь нет вовсе — это расчёты, и проверяются они на выдуманных строках.

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLanes, laneOf, pauseAfter, pickComments } from "./sync.mjs";
import { groupRequests, covers } from "./requests.mjs";

// --- деление на полосы --------------------------------------------------------------------

test("креаторы делятся по площадке, порядок внутри полосы сохраняется", () => {
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

test("площадка не указана — это TikTok; чужая площадка идёт туда же и падает своей ошибкой", () => {
  assert.equal(laneOf({ handle: "x" }), "tt");
  assert.equal(laneOf({ handle: "x", platform: "youtube" }), "tt");
  assert.equal(laneOf({ handle: "x", platform: "instagram" }), "ig");
});

test("пустой список полос не ломает", () => {
  assert.deepEqual(splitLanes([]), { tt: [], ig: [] });
  assert.deepEqual(splitLanes(undefined), { tt: [], ig: [] });
});

// --- паузы --------------------------------------------------------------------------------

test("пауза только между креаторами TikTok", () => {
  assert.equal(pauseAfter("tt"), true);
  assert.equal(pauseAfter("ig"), false, "у Instagram браузер общий — ждать нечего");
});

test("после «профиль не найден» паузы нет: страницы не было, очереди к TikTok тоже", () => {
  assert.equal(pauseAfter("tt", "профиль не найден: @demo_tiktok"), false);
  assert.equal(pauseAfter("tt", "стоп-экран TikTok у @khaby.lame"), true, "капча — как раз повод переждать");
  assert.equal(pauseAfter("ig", "Instagram: профиль не найден: @demo"), false);
});

// --- склейка просьб -----------------------------------------------------------------------

const req = (id, extra = {}) => ({ id, creator_id: null, depth: "all", requested_by: null, ...extra });

test("две просьбы одного охвата и глубины — один обход, галочки складываются по «или»", () => {
  const groups = groupRequests([
    req(1, { comments: false, replies: false }),
    req(2, { comments: true, replies: false }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [1, 2]);
  assert.equal(groups[0].comments, true, "true поглощает false");
  assert.equal(groups[0].replies, false, "веток не просил никто — и не раскрываем");
});

test("обход всех забирает частную просьбу вместе с её галочками", () => {
  const groups = groupRequests([
    req(1, { creator_id: "c1", depth: "all", comments: true, replies: true }),
    req(2, { creator_id: null, depth: "all", comments: false, replies: false }),
  ]);
  assert.equal(groups.length, 1, "частная просьба покрыта обходом всех");
  assert.deepEqual(groups[0].ids.sort(), [1, 2]);
  assert.equal(groups[0].comments, true, "поглощённая просьба не теряет своих комментариев");
  assert.equal(groups[0].replies, true);
});

test("«все, неделя» не покрывает «этот креатор, всё» — обходов два, галочки у каждого свои", () => {
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

test("нет полей вовсе (старая просьба) — считаем «снимать», как было до галочек", () => {
  const [group] = groupRequests([req(1)]);
  assert.equal(group.comments, true);
  assert.equal(group.replies, true);
});

test("покрытие: шире по охвату и не мельче по глубине", () => {
  assert.equal(covers({ creatorId: null, depth: "all" }, { creatorId: "c1", depth: "week" }), true);
  assert.equal(covers({ creatorId: null, depth: "week" }, { creatorId: "c1", depth: "all" }), false);
  assert.equal(covers({ creatorId: "c1", depth: "all" }, { creatorId: "c2", depth: "all" }), false);
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

test("число комментариев то же, что при прошлом съёме — видео не открываем", () => {
  const videos = [video("a", 42, 1), video("b", 43, 1)];
  const known = new Map([["a", 42], ["b", 42]]);
  const { picked, unchanged } = pickComments(videos, known, SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["b"], "у b комментариев прибавилось — снимаем");
  assert.deepEqual(unchanged.map((v) => v.id), ["a"]);
});

test("первый раз (в базе null или вовсе ничего) — снимаем всегда", () => {
  const videos = [video("a", 10, 1), video("b", 10, 1)];
  const known = new Map([["a", null]]);
  const { picked, unchanged } = pickComments(videos, known, SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["a", "b"]);
  assert.equal(unchanged.length, 0);
});

test("комментариев стало МЕНЬШЕ (удалили) — это тоже изменение, снимаем", () => {
  const { picked } = pickComments([video("a", 8, 1)], new Map([["a", 12]]), SINCE);
  assert.deepEqual(picked.map((v) => v.id), ["a"]);
});

test("старое и пустое не берётся ни в снятые, ни в «без изменений»", () => {
  const videos = [video("old", 100, 30), video("empty", 0, 1), { id: "nodate", comments: 5, publishedAt: null }];
  const { picked, unchanged } = pickComments(videos, new Map(), SINCE);
  assert.equal(picked.length, 0);
  assert.equal(unchanged.length, 0, "пропущенное по свежести в счёт «без изменений» не идёт");
});

test("счётчик базы приезжает строкой — сравнение всё равно числовое", () => {
  const { picked, unchanged } = pickComments([video("a", 42, 1)], new Map([["a", "42"]]), SINCE);
  assert.equal(picked.length, 0);
  assert.equal(unchanged.length, 1);
});

// Разбор прямых запросов TikTok — на кусках той же формы, что пришли в пробе 2026-09-10.
// Сеть здесь не трогается вовсе: проверяются только чистые функции разбора (`direct.mjs`).
// Тела настоящих ответов сюда не кладём: репозиторий публичный, а в комментариях живые люди.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComments, parseReplies, parseProfileHtml } from "./direct.mjs";
import { commentKeys, calibrateComments, estimateCreator, DEFAULT_TIMING, normalizeTiming } from "./estimate.mjs";

// --- `/api/comment/list/` ------------------------------------------------------------------

const listBody = {
  status_code: 0,
  total: 62,
  has_more: 1,
  cursor: 20,
  comments: [
    {
      cid: "7680720399881093909",
      text: "первый корневой",
      digg_count: 4,
      reply_comment_total: 2,
      create_time: 1788307101,
      reply_id: "0",
      reply_to_reply_id: "0",
      user: { unique_id: "learnwithbr7", nickname: "Learnwithbr" },
      // Даровые ответы: TikTok кладёт их внутрь корневого, и они не стоят ни клика, ни запроса.
      reply_comment: [
        { cid: "7680675238183633672", text: "даровой ответ", digg_count: 0, create_time: 1788307200, reply_id: "7680720399881093909", user: { unique_id: "natalia", nickname: "Natalia" } },
      ],
    },
    { cid: "7680683680687670023", text: "второй корневой", digg_count: 0, reply_comment_total: 0, create_time: 1788307000, reply_id: "0", user: { unique_id: "someone", nickname: "Кто-то" } },
    { text: "без cid — такую строку не записать: ключ таблицы (video_id, id)", user: { unique_id: "nobody" } },
  ],
};

test("parseComments: корневые, даровые ответы и конец списка", () => {
  const got = parseComments(JSON.stringify(listBody));
  assert.equal(got.ok, true);
  assert.equal(got.comments.length, 2);          // третья строка без cid отброшена
  assert.equal(got.comments[0].id, "7680720399881093909");
  assert.equal(got.comments[0].parentId, null);
  assert.equal(got.comments[0].authorHandle, "learnwithbr7");
  assert.equal(got.comments[0].likes, 4);
  assert.equal(got.comments[0].replies, 2);
  assert.equal(got.comments[0].createdAt, new Date(1788307101 * 1000).toISOString());
  assert.equal(got.replies.length, 1);
  assert.equal(got.replies[0].parentId, "7680720399881093909");
  assert.equal(got.replies[0].replies, null);    // третьего уровня у TikTok нет
  assert.equal(got.hasMore, true);               // ⚠️ `has_more` приходит числом 0/1
  assert.equal(got.cursor, 20);
  assert.equal(got.total, 62);
});

test("parseComments: последняя страница — has_more 0", () => {
  const got = parseComments(JSON.stringify({ ...listBody, has_more: 0, cursor: 40 }));
  assert.equal(got.ok, true);
  assert.equal(got.hasMore, false);
  assert.equal(got.cursor, 40);
});

test("parseComments: пустое тело — «прямой не дал», а не исключение", () => {
  for (const body of ["", "   "]) {
    const got = parseComments(body);
    assert.equal(got.ok, false);
    assert.match(got.why, /пустое тело/);
    assert.deepEqual(got.comments, []);
  }
});

test("parseComments: не-JSON — признак отказа", () => {
  const got = parseComments("<!doctype html><html>капча</html>");
  assert.equal(got.ok, false);
  assert.match(got.why, /не JSON/);
});

test("parseComments: status_code != 0 — признак отказа с текстом площадки", () => {
  const got = parseComments(JSON.stringify({ status_code: 10000, status_msg: "нельзя", comments: [] }));
  assert.equal(got.ok, false);
  assert.match(got.why, /status_code 10000/);
  assert.match(got.why, /нельзя/);
});

test("parseComments: ответ без comments[] — отказ", () => {
  const got = parseComments(JSON.stringify({ status_code: 0, total: 5 }));
  assert.equal(got.ok, false);
  assert.match(got.why, /comments/);
});

test("parseComments: ноль комментариев при status_code 0 — это НЕ отказ разбора", () => {
  // Решение «прямой не дал» принимает `fetchComments` по счётчику площадки, а не разбор:
  // у видео и правда бывает ноль комментариев.
  const got = parseComments(JSON.stringify({ status_code: 0, comments: [], total: 0, has_more: 0, cursor: 20 }));
  assert.equal(got.ok, true);
  assert.deepEqual(got.comments, []);
  assert.equal(got.total, 0);
});

// --- `/api/comment/list/reply/` ------------------------------------------------------------

const replyBody = {
  status_code: 0,
  total: 1,
  has_more: 0,
  cursor: 20,
  comments: [
    { cid: "7680675238183633672", text: "ответ ветки", digg_count: 1, create_time: 1788307200, reply_id: "7680674945520911112", reply_to_reply_id: "0", user: { unique_id: "natalia", nickname: "Natalia" } },
  ],
};

test("parseReplies: родитель берётся из reply_id ответа", () => {
  const got = parseReplies(JSON.stringify(replyBody), "7680674945520911112");
  assert.equal(got.ok, true);
  assert.equal(got.replies.length, 1);
  assert.equal(got.replies[0].id, "7680675238183633672");
  assert.equal(got.replies[0].parentId, "7680674945520911112");
  assert.equal(got.replies[0].replies, null);
  assert.equal(got.hasMore, false);
});

test("parseReplies: ответ, забывший назвать родителя, подписывается веткой, которую просили", () => {
  const nameless = { ...replyBody, comments: [{ ...replyBody.comments[0], reply_id: "0" }] };
  const got = parseReplies(JSON.stringify(nameless), "7680674945520911112");
  assert.equal(got.ok, true);
  assert.equal(got.replies.length, 1);
  assert.equal(got.replies[0].parentId, "7680674945520911112");
});

test("parseReplies: без имени ветки безродный ответ выбрасывается, а не ложится корневым", () => {
  const nameless = { ...replyBody, comments: [{ ...replyBody.comments[0], reply_id: "0" }] };
  const got = parseReplies(JSON.stringify(nameless), null);
  assert.equal(got.ok, true);
  assert.deepEqual(got.replies, []);
});

test("parseReplies: пустое тело и не-JSON — тот же признак отказа", () => {
  assert.equal(parseReplies("").ok, false);
  assert.equal(parseReplies("не json").ok, false);
  assert.deepEqual(parseReplies("").replies, []);
});

// --- HTML профиля --------------------------------------------------------------------------

/** Кусок страницы `@handle` той же формы, что приезжает живьём (360 КБ, здесь — только суть). */
const profileHtml = (userInfo) => `<!doctype html><html><head></head><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
  __DEFAULT_SCOPE__: { "webapp.user-detail": { userInfo } },
})}</script></body></html>`;

test("parseProfileHtml: счётчики, аватар и secUid", () => {
  const got = parseProfileHtml(profileHtml({
    user: { nickname: "Аурея", signature: "подпись", avatarLarger: "https://p16/large.jpeg", secUid: "MS4wLjABAAAAzMv10WWI" },
    statsV2: { followerCount: "9", followingCount: "48", heartCount: "275", videoCount: "7" },
    stats: { followerCount: 9, heartCount: -12, videoCount: 7 },
  }));
  assert.equal(got.ok, true);
  assert.equal(got.profile.followers, 9);
  assert.equal(got.profile.following, 48);
  // ⚠️ statsV2 первым: в старом `stats.heartCount` у крупных креаторов переполнение (минус).
  assert.equal(got.profile.likesTotal, 275);
  assert.equal(got.profile.videosCount, 7);
  assert.equal(got.profile.avatar, "https://p16/large.jpeg");
  assert.equal(got.profile.secUid, "MS4wLjABAAAAzMv10WWI");
});

test("parseProfileHtml: statsV2 нет — счётчики берутся из старого stats", () => {
  const got = parseProfileHtml(profileHtml({ user: { nickname: "Кто-то" }, stats: { followerCount: 64, followingCount: 39, heartCount: 614, videoCount: 8 } }));
  assert.equal(got.ok, true);
  assert.equal(got.profile.followers, 64);
  assert.equal(got.profile.likesTotal, 614);
  assert.equal(got.profile.avatar, null);
});

test("parseProfileHtml: пусто, без скрипта, без userInfo и без счётчиков — признак отказа", () => {
  assert.match(parseProfileHtml("").why, /пустой HTML/);
  assert.match(parseProfileHtml("<html>капча</html>").why, /UNIVERSAL_DATA/);
  assert.match(parseProfileHtml(profileHtml(null)).why, /userInfo/);
  assert.match(parseProfileHtml(profileHtml({ user: { nickname: "x" } })).why, /счётчик/);
  for (const html of ["", "<html></html>", profileHtml(null)]) assert.equal(parseProfileHtml(html).ok, false);
});

test("parseProfileHtml: испорченный JSON внутри скрипта — отказ, а не исключение", () => {
  const got = parseProfileHtml('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{ не json </script>');
  assert.equal(got.ok, false);
  assert.match(got.why, /не разобрались/);
});

// --- Единицы калибровки прямого пути (`estimate.mjs`) --------------------------------------

test("commentKeys: прямой путь считается своей парой единиц", () => {
  assert.deepEqual(commentKeys(true), { video: "comments.direct", replies: "replies.direct" });
  assert.deepEqual(commentKeys(false), { video: "comments.video", replies: "replies.video" });
});

test("умолчания прямого пути — 2 и 3 секунды", () => {
  assert.equal(DEFAULT_TIMING["comments.direct"], 2);
  assert.equal(DEFAULT_TIMING["replies.direct"], 3);
  // Старый файл калибровки без этих ключей читается без правки: недостающее берётся из умолчаний.
  const old = normalizeTiming({ "comments.video": 30, "replies.video": 50 });
  assert.equal(old["comments.direct"], 2);
  assert.equal(old["replies.direct"], 3);
});

test("оценка выбирает дешёвые единицы, когда прямой путь включён", () => {
  const base = { handle: "a", platform: "tiktok", scrolls: 1, commentVideos: 10 };
  const withDirect = estimateCreator({ ...base, direct: true });
  const withBrowser = estimateCreator({ ...base, direct: false });
  assert.equal(withDirect.comments, 10 * 2);
  assert.equal(withDirect.replies, 10 * 3);
  assert.equal(withBrowser.comments, 10 * 25);
  assert.equal(withBrowser.replies, 10 * 40);
  assert.ok(withDirect.total < withBrowser.total);
});

test("у Instagram прямого пути нет: оценка считает браузерными единицами даже при direct", () => {
  const one = estimateCreator({ handle: "a", platform: "instagram", scrolls: 1, commentVideos: 4, direct: true });
  assert.equal(one.comments, 4 * 25);
});

test("калибровка путей порознь: замер прямого не двигает цену браузерного", () => {
  const before = normalizeTiming({});
  // Десять видео за 20 с — ровно умолчание прямого пути с ветками (2 + 3 = 5 с на видео → 50 с).
  const after = calibrateComments(before, 20, 10, true, undefined, true);
  assert.ok(after["comments.direct"] < before["comments.direct"]);
  assert.equal(after["comments.video"], before["comments.video"]);
  assert.equal(after["replies.video"], before["replies.video"]);

  // Браузерный путь: 130 с на видео против ожидаемых 65 — обе его цены идут вверх.
  const browser = calibrateComments(before, 1300, 10, true, undefined, false);
  assert.ok(browser["comments.video"] > before["comments.video"]);
  assert.equal(browser["comments.direct"], before["comments.direct"]);
});

test("калибровка прямого пути без веток трогает только цену видео", () => {
  const before = normalizeTiming({});
  // Пять видео за 5 с — секунда на видео против умолчания в две.
  const after = calibrateComments(before, 5, 5, false, undefined, true);
  assert.notEqual(after["comments.direct"], before["comments.direct"]);
  assert.equal(after["replies.direct"], before["replies.direct"]);
});

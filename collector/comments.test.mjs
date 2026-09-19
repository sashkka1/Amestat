// Разбор комментариев обеих площадок — на телах той же формы, что пришли в пробах 2026-09-08.
// Тела настоящих ответов сюда не кладём: репозиторий публичный, а в комментариях живые люди.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTikTokComments, photoUrl, openPost } from "./comments-tiktok.mjs";
import { parseInstagramComments, commentsFromHtml } from "./comments-instagram.mjs";
import { pickReplies, branchesOf } from "./replies.mjs";
import { buildMessage } from "./notices.mjs";

// --- TikTok: `/api/comment/list/` ---------------------------------------------------------

const ttBody = {
  comments: [
    {
      cid: "7682050374178636558",
      aweme_id: "7681710657821052193",
      text: "My grandmother had a favourite brooch",
      digg_count: 96,
      reply_comment_total: 7,
      create_time: 1788616770,
      reply_id: "0",
      reply_to_reply_id: "0",
      user: { unique_id: "9th_dragon", nickname: "3⁹🪷tsarstvo" },
    },
    { cid: "7682325763681026838", text: "here you go", digg_count: 0, reply_comment_total: 0, create_time: 1788680890, reply_id: "0", user: { unique_id: "elenageo07", nickname: "Helen" } },
    { text: "no cid — such a row cannot be written", user: { unique_id: "nobody" } },
  ],
  has_more: 1,
  cursor: 20,
  total: 149,
};

test("TikTok: comments are parsed into the common shape", () => {
  const { comments, hasMore, cursor, total } = parseTikTokComments(ttBody);
  assert.equal(comments.length, 2, "a row without cid is skipped: the table key is (video_id, id)");
  assert.deepEqual(comments[0], {
    id: "7682050374178636558",
    parentId: null,
    authorHandle: "9th_dragon",
    authorName: "3⁹🪷tsarstvo",
    text: "My grandmother had a favourite brooch",
    likes: 96,
    replies: 7,
    createdAt: "2026-09-05T13:59:30.000Z",
  });
  assert.equal(hasMore, true, "has_more arrives as the number 1, not a boolean");
  assert.equal(cursor, 20);
  assert.equal(total, 149);
});

test("TikTok: has_more = 0 means the end of the list", () => {
  assert.equal(parseTikTokComments({ comments: [], has_more: 0 }).hasMore, false);
  assert.equal(parseTikTokComments({}).comments.length, 0);
  assert.equal(parseTikTokComments(null).hasMore, false);
});

test("TikTok: a reply to a comment remembers its parent", () => {
  const { comments } = parseTikTokComments({ comments: [{ cid: "2", reply_id: "1", text: "reply", user: {} }] });
  assert.equal(comments[0].parentId, "1");
  assert.equal(comments[0].authorHandle, "");
});

// --- Ответы на комментарии ------------------------------------------------------------------

test("TikTok: branch replies are parsed by the same parser, they have no replies of their own", () => {
  // Так выглядит тело `/api/comment/list/reply/`: те же поля, `reply_id` — id корневого.
  const { comments, replies, hasMore } = parseTikTokComments({
    comments: [
      { cid: "111", reply_id: "7682050374178636558", text: "mine too", digg_count: 3, reply_comment_total: 0, create_time: 1788616800, user: { unique_id: "kto", nickname: "Who" } },
      { cid: "222", reply_id: "7682050374178636558", text: "show me", digg_count: 0, create_time: 1788616900, user: { unique_id: "vtoroy" } },
    ],
    has_more: 0,
  });
  assert.equal(replies.length, 0, "in a branch the replies arrive as a plain list, not nested");
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], {
    id: "111",
    parentId: "7682050374178636558",
    authorHandle: "kto",
    authorName: "Who",
    text: "mine too",
    likes: 3,
    replies: null,     // у ответа своих ответов не бывает: третьего уровня у TikTok нет
    createdAt: "2026-09-05T14:00:00.000Z",
  });
  assert.equal(hasMore, false);
});

test("TikTok: the first replies come for free inside the root comment", () => {
  const { comments, replies } = parseTikTokComments({
    comments: [{
      cid: "900",
      text: "root",
      reply_comment_total: 5,
      reply_id: "0",
      user: { unique_id: "root" },
      reply_comment: [
        { cid: "901", text: "first reply", digg_count: 1, create_time: 1788616800, user: { unique_id: "a" } },
        { cid: "902", reply_id: "900", text: "second", user: { unique_id: "b" } },
        { text: "no cid — cannot be written", user: {} },
      ],
    }],
  });
  assert.equal(comments.length, 1, "one root: the nested ones are not mixed into the common list");
  assert.equal(comments[0].replies, 5);
  assert.deepEqual(replies.map((r) => [r.id, r.parentId, r.replies]), [["901", "900", null], ["902", "900", null]]);
});

test("Instagram: the reply branch is found by the child_comments key and parsed", () => {
  const body = {
    data: {
      xdt_api__v1__media__comment_id__child_comments__connection: {
        edges: [{ node: { pk: "17999", text: "reply", created_at: 1788540100, parent_comment_id: "18110688224038998", user: { username: "kto", full_name: "Who" } } }],
        page_info: { has_next_page: false },
      },
    },
  };
  // Ключ ветки содержит `comments__connection`, поэтому его находит тот же обход дерева,
  // что и корневые: отдельного пути для ответов нет вовсе.
  const html = `<script type="application/json" data-sjs>${JSON.stringify(body)}</script>`;
  const found = commentsFromHtml(html);
  assert.equal(found.length, 1);
  const { comments } = parseInstagramComments(found[0]);
  assert.equal(comments[0].parentId, "18110688224038998");
  assert.equal(comments[0].replies, null, "a reply never has replies of its own");
});

test("Instagram: the first replies come for free in preview_child_comments", () => {
  const { comments, replies } = parseInstagramComments({
    edges: [{
      node: {
        pk: "500",
        text: "root",
        child_comment_count: 4,
        user: { username: "root" },
        preview_child_comments: [
          { pk: "501", text: "reply", created_at: 1788540100, user: { username: "a" } },
          { pk: "502", text: "second", parent_comment_id: "500", user: null, fallback_user_info: { username: "b" } },
        ],
      },
    }],
  });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].replies, 4);
  assert.deepEqual(replies.map((r) => [r.id, r.parentId, r.authorHandle]), [["501", "500", "a"], ["502", "500", "b"]]);
});

test("replies are capped and kept only under collected roots", () => {
  const roots = [{ id: "1" }, { id: "2" }];
  const replies = [
    { id: "a", parentId: "1" }, { id: "b", parentId: "1" }, { id: "c", parentId: "1" },
    { id: "d", parentId: "2" },
    { id: "e", parentId: "999" },   // корневой не попал в сбор — ответ в базу не пойдёт
    { id: "f", parentId: null },    // не ответ вовсе
  ];
  const picked = pickReplies(replies, roots, 2);
  assert.deepEqual(picked.map((r) => r.id), ["a", "b", "d"]);
  assert.equal(branchesOf(picked), 2);
});

// --- Сообщение о замечаниях -----------------------------------------------------------------

test("notice message: one line per notice, the overflow is counted", () => {
  const items = [
    { code: "creator", text: "@kto: video list is empty" },
    { code: "comments", text: "@kto video 1: captcha", count: 3 },
    { code: "images", text: "instagram/1/avatar.jpg: upload failed" },
  ];
  const text = buildMessage("Amestat, run #7 (schedule, all): collected 1, failed 1", items);
  assert.equal(text.split("\n").length, 4);
  assert.match(text, /\[creator\] @kto: video list is empty/);
  assert.match(text, /\[comments\] @kto video 1: captcha \(×3\)/, "repeats are merged into a counter");

  // Потолок: что не влезло — не пропадает молча, а считается хвостом.
  const many = Array.from({ length: 60 }, (_, i) => ({ code: "images", text: `image ${i} as long as a whole line, so the message hits its cap` }));
  const cut = buildMessage("header", many, 400);
  assert.ok(cut.length <= 400, `the message must not exceed the cap, but it came out ${cut.length}`);
  assert.match(cut, /… and \d+ more$/);
});

test("TikTok: a photo post is addressed by the same id through /photo/", () => {
  assert.equal(
    photoUrl("https://www.tiktok.com/@toplombard_warszaw/video/7682811121417456929", {}),
    "https://www.tiktok.com/@toplombard_warszaw/photo/7682811121417456929",
  );
  // Адреса `/video/` нет вовсе — собираем из ника и id.
  assert.equal(
    photoUrl("https://www.tiktok.com/@kto/", { creatorHandle: "@kto", id: "123" }),
    "https://www.tiktok.com/@kto/photo/123",
  );
  // Собрать не из чего — пробовать нечего, и вызывающий это увидит по null.
  assert.equal(photoUrl("https://www.tiktok.com/", {}), null);
  // Адрес уже фотопостовый — второй попытки не будет: она совпадёт с первой.
  assert.equal(
    photoUrl("https://www.tiktok.com/@kto/photo/123", { creatorHandle: "kto", id: "123" }),
    "https://www.tiktok.com/@kto/photo/123",
  );
});

// --- TikTok: запасной адрес `/photo/` ------------------------------------------------------
//
// Живьём эта развилка видна только тогда, когда TikTok снова откажет на `/video/`, поэтому
// страница здесь поддельная: она помнит, куда ходили, и отвечает так, как велено по адресу.

const VIDEO_URL = "https://www.tiktok.com/@toplombard_warszaw/video/7682811121417456929";
const PHOTO_URL = "https://www.tiktok.com/@toplombard_warszaw/photo/7682811121417456929";

/** `reply(адрес)` — Error (навигация упала) или код ответа; `hasPost(адрес)` — виден ли пост. */
function fakePage(reply, hasPost = () => true) {
  const visited = [];
  return {
    visited,
    async goto(link) {
      visited.push(link);
      const answer = reply(link);
      if (answer instanceof Error) throw answer;
      return { status: () => answer };
    },
    async waitForTimeout() {},
    async waitForSelector() {
      if (!hasPost(visited.at(-1))) throw new Error("node did not appear");
    },
    // Баннера cookies на поддельной странице нет вовсе.
    getByRole: () => ({ count: async () => 0, first: () => ({ click: async () => {} }) }),
  };
}

test("TikTok: `/video/` did not open — the post is taken from `/photo/`", async () => {
  const page = fakePage((link) => (link.includes("/video/") ? new Error("net::ERR_HTTP_RESPONSE_CODE_FAILURE") : 200));
  const lines = [];
  assert.equal(await openPost(page, VIDEO_URL, {}, (t) => lines.push(t)), "/photo/");
  assert.deepEqual(page.visited, [VIDEO_URL, PHOTO_URL], "the second attempt uses the same id, but in /photo/");
  assert.match(lines.join("\n"), /\/video\/ did not open, trying \/photo\//);
});

test("TikTok: a page without a post is also a reason to try `/photo/`", async () => {
  const page = fakePage(() => 200, (link) => link.includes("/photo/"));
  assert.equal(await openPost(page, VIDEO_URL, {}, () => {}), "/photo/");
});

test("TikTok: `/video/` opened — there is no second attempt", async () => {
  const page = fakePage(() => 200);
  assert.equal(await openPost(page, VIDEO_URL, {}), "/video/");
  assert.deepEqual(page.visited, [VIDEO_URL]);
});

test("TikTok: neither one opened — the same error as before, not silence", async () => {
  const page = fakePage((link) => (link.includes("/video/") ? new Error("net::ERR_HTTP_RESPONSE_CODE_FAILURE") : 404));
  await assert.rejects(
    () => openPost(page, VIDEO_URL, {}, () => {}),
    /^Error: video page did not open: net::ERR_HTTP_RESPONSE_CODE_FAILURE; \/photo\/ either: HTTP 404$/,
  );
});

// --- Instagram: `…media_id__comments__connection` ------------------------------------------

const igConnection = {
  edges: [
    {
      node: {
        pk: "18110688224038998",
        text: "Just a little pampering",
        created_at: 1788540045,
        comment_like_count: 150,
        child_comment_count: 19,
        parent_comment_id: null,
        user: { username: "mirapollock", full_name: "Mira" },
      },
    },
    {
      node: {
        pk: "17918583354432629",
        text: "Relaxing",
        created_at: 1788863713,
        comment_like_count: 0,
        child_comment_count: 0,
        parent_comment_id: "18110688224038998",
        user: null,
        fallback_user_info: { username: "richfixhome" },
      },
    },
  ],
  page_info: { end_cursor: "{\"cached_comments_cursor\":\"18115539877767971\"}", has_next_page: true },
};

test("Instagram: comments are parsed into the common shape", () => {
  const { comments, hasNext, endCursor } = parseInstagramComments(igConnection);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], {
    id: "18110688224038998",
    parentId: null,
    authorHandle: "mirapollock",
    authorName: "Mira",
    text: "Just a little pampering",
    likes: 150,
    replies: 19,
    createdAt: "2026-09-04T16:40:45.000Z",
  });
  // Автор без `user` — имя лежит в `fallback_user_info`, иначе строка ушла бы безымянной.
  assert.equal(comments[1].authorHandle, "richfixhome");
  assert.equal(comments[1].parentId, "18110688224038998");
  assert.equal(hasNext, true);
  assert.ok(endCursor.includes("cached_comments_cursor"));
});

test("Instagram: has_next_page = false means the end of the list", () => {
  const { hasNext } = parseInstagramComments({ edges: [], page_info: { has_next_page: false } });
  assert.equal(hasNext, false);
  // Связки нет вовсе — считаем, что продолжение возможно: обрывать сбор из-за этого нельзя.
  assert.equal(parseInstagramComments(null).hasNext, true);
});

test("Instagram: the first comments are taken straight from the page HTML", () => {
  const payload = { require: [["ScheduledServerJS", "handle", [{ __bbox: { result: { data: { xdt_api__v1__media__media_id__comments__connection: igConnection } } } }]]] };
  const html = [
    "<html><head><title>x</title></head><body>",
    '<script type="application/json" data-content-len="10" data-sjs>{"require":[]}</script>',
    `<script type="application/json" data-sjs>${JSON.stringify(payload)}</script>`,
    '<script type="application/json" data-sjs>not json at all {{{</script>',
    "</body></html>",
  ].join("");
  const found = commentsFromHtml(html);
  assert.equal(found.length, 1, "only the chunk that holds the comments connection is taken");
  assert.equal(parseInstagramComments(found[0]).comments.length, 2);
  assert.deepEqual(commentsFromHtml("<html></html>"), []);
});

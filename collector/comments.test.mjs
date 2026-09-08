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
      text: "У моей бабушки была любимая брошь",
      digg_count: 96,
      reply_comment_total: 7,
      create_time: 1788616770,
      reply_id: "0",
      reply_to_reply_id: "0",
      user: { unique_id: "9th_dragon", nickname: "3⁹🪷tsarstvo" },
    },
    { cid: "7682325763681026838", text: "вот вам", digg_count: 0, reply_comment_total: 0, create_time: 1788680890, reply_id: "0", user: { unique_id: "elenageo07", nickname: "Helen" } },
    { text: "без cid — такую строку не записать", user: { unique_id: "nobody" } },
  ],
  has_more: 1,
  cursor: 20,
  total: 149,
};

test("TikTok: комментарии разбираются в общую форму", () => {
  const { comments, hasMore, cursor, total } = parseTikTokComments(ttBody);
  assert.equal(comments.length, 2, "строка без cid пропускается: ключ таблицы — (video_id, id)");
  assert.deepEqual(comments[0], {
    id: "7682050374178636558",
    parentId: null,
    authorHandle: "9th_dragon",
    authorName: "3⁹🪷tsarstvo",
    text: "У моей бабушки была любимая брошь",
    likes: 96,
    replies: 7,
    createdAt: "2026-09-05T13:59:30.000Z",
  });
  assert.equal(hasMore, true, "has_more приезжает числом 1, а не булевым");
  assert.equal(cursor, 20);
  assert.equal(total, 149);
});

test("TikTok: has_more = 0 значит конец списка", () => {
  assert.equal(parseTikTokComments({ comments: [], has_more: 0 }).hasMore, false);
  assert.equal(parseTikTokComments({}).comments.length, 0);
  assert.equal(parseTikTokComments(null).hasMore, false);
});

test("TikTok: ответ на комментарий помнит родителя", () => {
  const { comments } = parseTikTokComments({ comments: [{ cid: "2", reply_id: "1", text: "ответ", user: {} }] });
  assert.equal(comments[0].parentId, "1");
  assert.equal(comments[0].authorHandle, "");
});

// --- Ответы на комментарии ------------------------------------------------------------------

test("TikTok: ответы ветки разбираются тем же разборщиком, своих ответов у них нет", () => {
  // Так выглядит тело `/api/comment/list/reply/`: те же поля, `reply_id` — id корневого.
  const { comments, replies, hasMore } = parseTikTokComments({
    comments: [
      { cid: "111", reply_id: "7682050374178636558", text: "и у моей", digg_count: 3, reply_comment_total: 0, create_time: 1788616800, user: { unique_id: "kto", nickname: "Кто" } },
      { cid: "222", reply_id: "7682050374178636558", text: "покажи", digg_count: 0, create_time: 1788616900, user: { unique_id: "vtoroy" } },
    ],
    has_more: 0,
  });
  assert.equal(replies.length, 0, "в ветке ответы приезжают обычным списком, а не вложенными");
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], {
    id: "111",
    parentId: "7682050374178636558",
    authorHandle: "kto",
    authorName: "Кто",
    text: "и у моей",
    likes: 3,
    replies: null,     // у ответа своих ответов не бывает: третьего уровня у TikTok нет
    createdAt: "2026-09-05T14:00:00.000Z",
  });
  assert.equal(hasMore, false);
});

test("TikTok: первые ответы приезжают даром внутри корневого", () => {
  const { comments, replies } = parseTikTokComments({
    comments: [{
      cid: "900",
      text: "корневой",
      reply_comment_total: 5,
      reply_id: "0",
      user: { unique_id: "root" },
      reply_comment: [
        { cid: "901", text: "первый ответ", digg_count: 1, create_time: 1788616800, user: { unique_id: "a" } },
        { cid: "902", reply_id: "900", text: "второй", user: { unique_id: "b" } },
        { text: "без cid — не записать", user: {} },
      ],
    }],
  });
  assert.equal(comments.length, 1, "корневой один: вложенные в общий список не подмешиваются");
  assert.equal(comments[0].replies, 5);
  assert.deepEqual(replies.map((r) => [r.id, r.parentId, r.replies]), [["901", "900", null], ["902", "900", null]]);
});

test("Instagram: ветка ответов находится по ключу child_comments и разбирается", () => {
  const body = {
    data: {
      xdt_api__v1__media__comment_id__child_comments__connection: {
        edges: [{ node: { pk: "17999", text: "ответ", created_at: 1788540100, parent_comment_id: "18110688224038998", user: { username: "kto", full_name: "Кто" } } }],
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
  assert.equal(comments[0].replies, null, "у ответа своих ответов не бывает");
});

test("Instagram: первые ответы приезжают даром в preview_child_comments", () => {
  const { comments, replies } = parseInstagramComments({
    edges: [{
      node: {
        pk: "500",
        text: "корневой",
        child_comment_count: 4,
        user: { username: "root" },
        preview_child_comments: [
          { pk: "501", text: "ответ", created_at: 1788540100, user: { username: "a" } },
          { pk: "502", text: "второй", parent_comment_id: "500", user: null, fallback_user_info: { username: "b" } },
        ],
      },
    }],
  });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].replies, 4);
  assert.deepEqual(replies.map((r) => [r.id, r.parentId, r.authorHandle]), [["501", "500", "a"], ["502", "500", "b"]]);
});

test("ответы обрезаются по потолку и только под собранными корневыми", () => {
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

test("сообщение о замечаниях: строка на замечание, лишнее считается", () => {
  const items = [
    { code: "creator", text: "@kto: список видео пуст" },
    { code: "comments", text: "@kto видео 1: капча", count: 3 },
    { code: "images", text: "instagram/1/avatar.jpg: не залилась" },
  ];
  const text = buildMessage("Amestat, обход #7 (schedule, всё): собрано 1, с ошибкой 1", items);
  assert.equal(text.split("\n").length, 4);
  assert.match(text, /\[creator\] @kto: список видео пуст/);
  assert.match(text, /\[comments\] @kto видео 1: капча \(×3\)/, "повторы склеиваются в счётчик");

  // Потолок: что не влезло — не пропадает молча, а считается хвостом.
  const many = Array.from({ length: 60 }, (_, i) => ({ code: "images", text: `картинка ${i} длиной в целую строку, чтобы упереться в потолок сообщения` }));
  const cut = buildMessage("шапка", many, 400);
  assert.ok(cut.length <= 400, `сообщение не длиннее потолка, а вышло ${cut.length}`);
  assert.match(cut, /… и ещё \d+$/);
});

test("TikTok: фотопост адресуется тем же id через /photo/", () => {
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
      if (!hasPost(visited.at(-1))) throw new Error("узел не появился");
    },
    // Баннера cookies на поддельной странице нет вовсе.
    getByRole: () => ({ count: async () => 0, first: () => ({ click: async () => {} }) }),
  };
}

test("TikTok: `/video/` не открылся — пост берётся по `/photo/`", async () => {
  const page = fakePage((link) => (link.includes("/video/") ? new Error("net::ERR_HTTP_RESPONSE_CODE_FAILURE") : 200));
  const lines = [];
  assert.equal(await openPost(page, VIDEO_URL, {}, (t) => lines.push(t)), "/photo/");
  assert.deepEqual(page.visited, [VIDEO_URL, PHOTO_URL], "второй ход идёт по тому же id, но в /photo/");
  assert.match(lines.join("\n"), /\/video\/ не открылся, пробую \/photo\//);
});

test("TikTok: страница без поста — тоже повод попробовать `/photo/`", async () => {
  const page = fakePage(() => 200, (link) => link.includes("/photo/"));
  assert.equal(await openPost(page, VIDEO_URL, {}, () => {}), "/photo/");
});

test("TikTok: `/video/` открылся — второго хода нет", async () => {
  const page = fakePage(() => 200);
  assert.equal(await openPost(page, VIDEO_URL, {}), "/video/");
  assert.deepEqual(page.visited, [VIDEO_URL]);
});

test("TikTok: не открылось ни то ни другое — прежняя ошибка, а не тишина", async () => {
  const page = fakePage((link) => (link.includes("/video/") ? new Error("net::ERR_HTTP_RESPONSE_CODE_FAILURE") : 404));
  await assert.rejects(
    () => openPost(page, VIDEO_URL, {}, () => {}),
    /^Error: страница видео не открылась: net::ERR_HTTP_RESPONSE_CODE_FAILURE; \/photo\/ тоже: ответ 404$/,
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

test("Instagram: комментарии разбираются в общую форму", () => {
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

test("Instagram: has_next_page = false значит конец списка", () => {
  const { hasNext } = parseInstagramComments({ edges: [], page_info: { has_next_page: false } });
  assert.equal(hasNext, false);
  // Связки нет вовсе — считаем, что продолжение возможно: обрывать сбор из-за этого нельзя.
  assert.equal(parseInstagramComments(null).hasNext, true);
});

test("Instagram: первые комментарии достаются прямо из HTML страницы", () => {
  const payload = { require: [["ScheduledServerJS", "handle", [{ __bbox: { result: { data: { xdt_api__v1__media__media_id__comments__connection: igConnection } } } }]]] };
  const html = [
    "<html><head><title>x</title></head><body>",
    '<script type="application/json" data-content-len="10" data-sjs>{"require":[]}</script>',
    `<script type="application/json" data-sjs>${JSON.stringify(payload)}</script>`,
    '<script type="application/json" data-sjs>не json вовсе {{{</script>',
    "</body></html>",
  ].join("");
  const found = commentsFromHtml(html);
  assert.equal(found.length, 1, "берётся только тот кусок, где есть связка комментариев");
  assert.equal(parseInstagramComments(found[0]).comments.length, 2);
  assert.deepEqual(commentsFromHtml("<html></html>"), []);
});

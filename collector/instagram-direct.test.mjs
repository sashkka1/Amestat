// Прямые запросы Instagram из вкладки-якоря (владелец, 2026-09-16: «комбинированный обход, как и
// в случае с TikTok»). Сети и браузера здесь нет: разбор проверяется на ответах того вида, что
// пришли на пробе, а листание — на поддельном якоре, который отдаёт страницы по очереди.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIgResponse, parseIgCommentsPage, parseIgChildPage, fetchIgComments, fetchIgReplies,
  templateFromRequest, feedVariables, reelsVariables, feedConnectionOf, clipsConnectionOf, playsFromClips, profileFromInfo, uidFromSearch,
  FEED_QUERY, REELS_QUERY, templatesFromFile,
} from "./instagram-direct.mjs";
import { newListState, takeFeedPage, takeClipsPage } from "./instagram-web.mjs";

const user = (username) => ({ username, full_name: `${username} name` });
const root = (pk, { child = 0, preview = [], likes = 0 } = {}) => ({
  pk, text: `text ${pk}`, created_at: 1789260566, comment_like_count: likes, child_comment_count: child, user: user(`u${pk}`), preview_child_comments: preview,
});
const reply = (pk, parent) => ({ pk, text: `reply ${pk}`, created_at: 1789260600, comment_like_count: 1, parent_comment_id: parent, user: user(`r${pk}`) });
const ok = (json) => ({ ok: true, why: null, json });

// ------------------------------------------------------------------ parsing the tab response
test("classifyIgResponse: JSON with status ok — accepted", () => {
  const got = classifyIgResponse({ status: 200, redirected: false, url: "https://www.instagram.com/api/v1/x", text: '{"status":"ok","comments":[]}' });
  assert.equal(got.ok, true);
  assert.deepEqual(got.json.comments, []);
});

test("classifyIgResponse: redirect to login, 429, non-JSON, fail and a network failure — «did not deliver» with a reason", () => {
  assert.match(classifyIgResponse({ status: 200, redirected: true, url: "https://www.instagram.com/accounts/login/?next=x", text: "<html>" }).why, /login/);
  assert.match(classifyIgResponse({ status: 429, text: "" }).why, /429/);
  assert.match(classifyIgResponse({ status: 200, text: "<html>" }).why, /not JSON/);
  assert.match(classifyIgResponse({ status: 200, text: '{"status":"fail","message":"login_required"}' }).why, /login_required/);
  assert.match(classifyIgResponse({ error: "Failed to fetch" }).why, /Failed to fetch/);
  assert.match(classifyIgResponse({ status: 500, text: "{}" }).why, /HTTP 500/);
  for (const bad of [{ status: 429 }, { error: "x" }, null]) assert.equal(classifyIgResponse(bad).ok, false);
});

// ------------------------------------------------------------------ page of roots
test("parseIgCommentsPage: roots in the collector shape, free replies under their own parent", () => {
  const page = parseIgCommentsPage({
    comment_count: 5, has_more_headload_comments: true, next_min_id: "{\"cursor\":1}",
    comments: [root("1", { child: 2, preview: [reply("11", "1")], likes: 3 }), root("2")],
  });
  assert.equal(page.ok, true);
  assert.deepEqual(page.comments.map((c) => [c.id, c.parentId, c.replies, c.likes, c.authorHandle]), [["1", null, 2, 3, "u1"], ["2", null, 0, 0, "u2"]]);
  assert.equal(page.comments[0].createdAt, new Date(1789260566 * 1000).toISOString());
  assert.deepEqual(page.replies.map((r) => [r.id, r.parentId, r.replies]), [["11", "1", null]]);
  assert.deepEqual(page.next, { param: "min_id", value: "{\"cursor\":1}" });
  assert.equal(page.total, 5);
});

test("parseIgCommentsPage: the «head» ran out — page through the «tail», everything ran out — next null", () => {
  assert.deepEqual(parseIgCommentsPage({ comments: [], has_more_headload_comments: false, has_more_comments: true, next_max_id: "m" }).next, { param: "max_id", value: "m" });
  assert.equal(parseIgCommentsPage({ comments: [], has_more_headload_comments: false, has_more_comments: false, next_min_id: "old" }).next, null);
  assert.equal(parseIgCommentsPage({ comments: [], has_more_headload_comments: true }).next, null, "a flag without a cursor — nothing to page with");
});

test("parseIgCommentsPage: no comments array — that is not an empty list but a «did not deliver»", () => {
  assert.equal(parseIgCommentsPage({ status: "ok" }).ok, false);
  assert.equal(parseIgCommentsPage(null).ok, false);
});

// ------------------------------------------------------------------ branch
test("parseIgChildPage: branch replies with a parent; without parent_comment_id the parent comes from the request", () => {
  const page = parseIgChildPage({
    child_comments: [reply("21", "2"), { pk: "22", text: "no parent", user: user("x") }],
    has_more_tail_child_comments: true, next_max_child_cursor: "c2",
  }, "2");
  assert.deepEqual(page.replies.map((r) => [r.id, r.parentId]), [["21", "2"], ["22", "2"]]);
  assert.deepEqual(page.next, { param: "max_id", value: "c2" });
  assert.equal(parseIgChildPage({ child_comments: [], has_more_tail_child_comments: false }, "2").next, null);
  assert.equal(parseIgChildPage({}, "2").ok, false);
});

// ------------------------------------------------------------------ paging on a fake anchor
function fakeAnchor(pages) {
  const asked = [];
  return {
    asked,
    get: async (path) => {
      asked.push(path);
      return pages.length > 0 ? pages.shift() : ok({ comments: [] });
    },
  };
}

test("fetchIgComments: pages through the platform cursor to the end and collects the free replies", async () => {
  const anchor = fakeAnchor([
    ok({ comment_count: 4, has_more_headload_comments: true, next_min_id: "A", comments: [root("1", { child: 1, preview: [reply("11", "1")] }), root("2")] }),
    ok({ comment_count: 4, has_more_headload_comments: false, comments: [root("3")] }),
  ]);
  const got = await fetchIgComments(anchor, "999", { max: 100, expected: 4, pauseMs: 0 });
  assert.equal(got.ok, true);
  assert.deepEqual(got.comments.map((c) => c.id), ["1", "2", "3"]);
  assert.deepEqual(got.free.map((r) => r.id), ["11"]);
  assert.equal(got.pages, 2);
  assert.equal(got.total, 4);
  assert.match(anchor.asked[0], /^\/api\/v1\/media\/999\/comments\/\?can_support_threading=true/);
  assert.match(anchor.asked[1], /&min_id=A$/);
});

test("fetchIgComments: 🔴 zero roots with a non-empty counter — «did not deliver», the browser will finish the job", async () => {
  const got = await fetchIgComments(fakeAnchor([ok({ comment_count: 0, comments: [] })]), "1", { expected: 12, pauseMs: 0 });
  assert.equal(got.ok, false);
  assert.match(got.why, /zero comments while the counter says 12/);
});

test("fetchIgComments: a refusal mid-paging — «did not deliver» entirely, not half a list", async () => {
  const anchor = fakeAnchor([
    ok({ has_more_headload_comments: true, next_min_id: "A", comments: [root("1")] }),
    { ok: false, why: "Instagram rate-limited the requests (429)", json: null },
  ]);
  const got = await fetchIgComments(anchor, "1", { expected: 5, pauseMs: 0 });
  assert.equal(got.ok, false);
  assert.match(got.why, /429/);
});

test("fetchIgComments: the root cap and a looping cursor stop the paging", async () => {
  const many = Array.from({ length: 15 }, (_, i) => root(String(i + 1)));
  const capped = await fetchIgComments(fakeAnchor([ok({ has_more_headload_comments: true, next_min_id: "A", comments: many })]), "1", { max: 10, pauseMs: 0 });
  assert.equal(capped.comments.length, 10);
  assert.equal(capped.pages, 1, "the cap is reached on the first page — no second request needed");

  const loop = fakeAnchor([
    ok({ has_more_headload_comments: true, next_min_id: "A", comments: [root("1")] }),
    ok({ has_more_headload_comments: true, next_min_id: "A", comments: [root("2")] }),
    ok({ has_more_headload_comments: true, next_min_id: "B", comments: [root("3")] }),
  ]);
  const got = await fetchIgComments(loop, "1", { pauseMs: 0 });
  assert.equal(got.pages, 2, "cursor A came a second time — the platform went in circles");
});

test("fetchIgReplies: a branch page by page, the cap of replies per branch", async () => {
  const anchor = fakeAnchor([
    ok({ child_comments: [reply("21", "2"), reply("22", "2")], has_more_tail_child_comments: true, next_max_child_cursor: "c" }),
    ok({ child_comments: [reply("23", "2")], has_more_tail_child_comments: false }),
  ]);
  const got = await fetchIgReplies(anchor, "999", "2", { max: 20, pauseMs: 0 });
  assert.equal(got.ok, true);
  assert.deepEqual(got.replies.map((r) => r.id), ["21", "22", "23"]);
  assert.match(anchor.asked[0], /^\/api\/v1\/media\/999\/comments\/2\/child_comments\/$/);
  assert.match(anchor.asked[1], /\?max_id=c$/);

  const capped = await fetchIgReplies(fakeAnchor([ok({ child_comments: [reply("1", "2"), reply("3", "2"), reply("4", "2")], has_more_tail_child_comments: true, next_max_child_cursor: "c" })]), "9", "2", { max: 2, pauseMs: 0 });
  assert.equal(capped.replies.length, 2);
  assert.equal(capped.pages, 1);
});

// ------------------------------------------------------------------ list: templates and replay
// Вид — тот, что пришёл на пробе 2026-09-16 (`@instagram`, `@orandocom.naty`).
const FEED_VARS = JSON.stringify({ data: { count: 12, include_relationship_info: true }, username: "instagram", "__relay_internal__pv__X": true });
const REELS_VARS = JSON.stringify({ data: { include_feed_video: true, page_size: 12, target_user_id: "25025320" }, user_id: "25025320", "__relay_internal__pv__Y": false });

test("templateFromRequest: takes a graphql request with doc_id and variables, drops the service headers", () => {
  const tpl = templateFromRequest({
    url: "https://www.instagram.com/graphql/query",
    method: "POST",
    headers: { "x-fb-friendly-name": FEED_QUERY, "x-fb-lsd": "L", "x-csrftoken": "C", cookie: "secret", "content-type": "x", "sec-fetch-site": "same-origin", referer: "r" },
    postData: new URLSearchParams({ doc_id: "283", variables: FEED_VARS, fb_dtsg: "D", lsd: "L" }).toString(),
  });
  assert.equal(tpl.body.doc_id, "283");
  assert.equal(tpl.body.fb_dtsg, "D");
  assert.deepEqual(Object.keys(tpl.headers).sort(), ["x-csrftoken", "x-fb-friendly-name", "x-fb-lsd"]);
});

test("templateFromRequest: not POST, not graphql, without doc_id or with broken variables — not a template", () => {
  const base = { url: "https://www.instagram.com/graphql/query", method: "POST", postData: new URLSearchParams({ doc_id: "1", variables: "{}" }).toString() };
  assert.ok(templateFromRequest(base));
  assert.equal(templateFromRequest({ ...base, method: "GET" }), null);
  assert.equal(templateFromRequest({ ...base, url: "https://www.instagram.com/api/v1/x" }), null);
  assert.equal(templateFromRequest({ ...base, postData: new URLSearchParams({ variables: "{}" }).toString() }), null);
  assert.equal(templateFromRequest({ ...base, postData: new URLSearchParams({ doc_id: "1", variables: "{not json" }).toString() }), null);
  assert.equal(REELS_QUERY, "PolarisProfileReelsTabContentQuery");
});

test("feedVariables: a different creator; the first page has no cursor, the next one has after and first", () => {
  const first = feedVariables(FEED_VARS, { username: "orandocom.naty" });
  assert.equal(first.username, "orandocom.naty");
  assert.equal("after" in first, false);
  assert.equal(first.data.count, 12, "the other template variables are left alone");
  const next = feedVariables(JSON.stringify({ ...first, after: "old" }), { username: "orandocom.naty", after: "3973_25025320" });
  assert.equal(next.after, "3973_25025320");
  assert.equal(next.first, 12);
  assert.equal("after" in feedVariables(JSON.stringify(next), { username: "x" }), false, "the cursor from the template does not leak into another creator's first page");
});

test("reelsVariables: the creator id changes EVERYWHERE it appears — otherwise the platform mixes two of them", () => {
  const v = reelsVariables(REELS_VARS, { uid: "32059687205", after: "AQH" });
  assert.equal(v.data.target_user_id, "32059687205");
  assert.equal(v.user_id, "32059687205");
  assert.equal(v.after, "AQH");
  assert.equal(v.first, 12);
  const withId = reelsVariables(JSON.stringify({ data: { target_user_id: "1" }, id: "1" }), { uid: 2 });
  assert.equal(withId.id, "2");
  assert.equal("user_id" in withId, false, "the key was not there — we do not add it");
});

test("feedConnectionOf / clipsConnectionOf: the connection is found wherever it lies", () => {
  const feed = { data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [], page_info: { has_next_page: false } } } };
  const clips = { data: { fetch__XDTUserDict: { clips_connection: { edges: [{ node: { media: { code: "a", pk: "1", play_count: 5 } } }] } } } };
  assert.ok(feedConnectionOf(feed));
  assert.equal(clipsConnectionOf(feed), null);
  assert.equal(clipsConnectionOf(clips).edges.length, 1);
  assert.equal(feedConnectionOf({ errors: [{}] }), null);
});

test("playsFromClips: views by code and pk, whoever has no play_count is skipped", () => {
  const got = playsFromClips({ edges: [
    { node: { media: { code: "DdNT", pk: "398", play_count: 15593 } } },
    { node: { media: { code: "none", pk: "1" } } },
    { node: { code: "flat", pk: "2", play_count: "7" } },
  ] });
  assert.deepEqual(got, [{ code: "DdNT", pk: "398", plays: 15593 }, { code: "flat", pk: "2", plays: 7 }]);
});

test("profileFromInfo: exact counters, name, biography, HD avatar; no user — null", () => {
  const p = profileFromInfo({ user: { pk: 32059687205, username: "orandocom.naty", follower_count: 222, following_count: 16, media_count: 3, full_name: "Naty", biography: "fé", hd_profile_pic_url_info: { url: "hd" }, profile_pic_url: "sd", is_private: false } });
  assert.deepEqual(p, { uid: "32059687205", username: "orandocom.naty", followers: 222, following: 16, videosCount: 3, nickname: "Naty", signature: "fé", avatar: "hd", isPrivate: false });
  assert.equal(profileFromInfo({ user: { username: "x" } }), null);
  assert.equal(profileFromInfo({}), null);
});

test("uidFromSearch: only an exact name, ignoring case and @", () => {
  const json = { users: [{ user: { username: "orandocom.naty2", pk: "9" } }, { user: { username: "Orandocom.Naty", pk: "32059687205" } }] };
  assert.equal(uidFromSearch(json, "@orandocom.naty"), "32059687205");
  assert.equal(uidFromSearch(json, "orandocom"), null);
  assert.equal(uidFromSearch({}, "x"), null);
});

// ------------------------------------------------------------------ list state
const post = (pk, owner, takenSec, pinned = false) => ({ node: { pk, user: { username: owner, pk: "u1" }, taken_at: takenSec, ...(pinned ? { timeline_pinned_user_ids: ["u1"] } : {}) } });

test("takeFeedPage: own posts into the state, other people's skipped; cursor and the end of the list", () => {
  const st = newListState();
  const added = takeFeedPage({ edges: [post("1", "naty", 100), post("2", "stranger", 100)], page_info: { end_cursor: "c1", has_next_page: true } }, st, { handle: "Naty" });
  assert.equal(added, 1);
  assert.deepEqual([...st.posts.keys()], ["1"]);
  assert.equal(st.feedCursor, "c1");
  assert.equal(st.hasNext, true);
  takeFeedPage({ edges: [post("1", "naty", 100)], page_info: { has_next_page: false } }, st, { handle: "naty" });
  assert.equal(st.hasNext, false);
  assert.equal(st.posts.size, 1, "a repeated batch (listener + replay) does not double anything");
});

test("takeFeedPage: the lower bound follows the oldest UNpinned post, a pinned one does not count", () => {
  const since = 1_000_000;
  const st = newListState();
  takeFeedPage({ edges: [post("p", "n", 10, true), post("a", "n", 2000)] }, st, { handle: "n", since });
  assert.equal(st.reachedOld, false, "an old pinned post does not stop the scrolling");
  assert.deepEqual([...st.pinned], ["p"]);
  takeFeedPage({ edges: [post("b", "n", 900)] }, st, { handle: "n", since });
  assert.equal(st.reachedOld, true);
});

test("takeClipsPage: views by code and pk, the reels counter, cursor and the end", () => {
  const st = newListState();
  takeClipsPage({ edges: [{ node: { media: { code: "c", pk: "7", play_count: 42 } } }], page_info: { end_cursor: "r1", has_next_page: true } }, st);
  assert.equal(st.plays.get("c"), 42);
  assert.equal(st.plays.get("7"), 42);
  assert.equal(st.reelsSeen, 1);
  assert.equal(st.reelsCursor, "r1");
  takeClipsPage({ edges: [], page_info: { has_next_page: false } }, st);
  assert.equal(st.reelsEnded, true);
  assert.equal(st.reelsCursor, null);
});

// ------------------------------------------------------------------ templates between runs (owner, 2026-09-17)
test("templatesFromFile: valid templates come back with their capture time", () => {
  const tpl = { url: "https://www.instagram.com/graphql/query", headers: { "x-fb-lsd": "L" }, body: { doc_id: "283", variables: "{}", fb_dtsg: "D" }, capturedAt: 1789600000000 };
  const got = templatesFromFile({ feed: tpl, reels: tpl, savedAt: 1789600000500 });
  assert.equal(got.feed.body.doc_id, "283");
  assert.equal(got.feed.capturedAt, 1789600000000);
  assert.deepEqual(got.reels.headers, { "x-fb-lsd": "L" });
  assert.equal(got.savedAt, 1789600000500);
});

test("templatesFromFile: a broken or foreign template is dropped on its own slot, not the whole file", () => {
  const good = { url: "u", body: { doc_id: "1", variables: "{}" } };
  const got = templatesFromFile({ feed: { url: "u", body: { doc_id: "1", variables: "{not json" } }, reels: good });
  assert.equal(got.feed, null);
  assert.equal(got.reels.body.doc_id, "1");
  assert.deepEqual(got.reels.headers, {}, "missing headers become an empty object");
  assert.deepEqual(templatesFromFile(null), { feed: null, reels: null, savedAt: null });
  assert.equal(templatesFromFile({ feed: { body: { doc_id: "1", variables: "{}" } } }).feed, null, "no url — not a template");
});

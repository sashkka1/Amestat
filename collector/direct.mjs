// Прямые запросы к TikTok — без браузера, без подписи, без профиля.
//
// Владелец, 2026-09-10: «делаем симбиоз: где можно — прямой запрос, где он не отработал — наш
// браузерный код; максимально делегировать прямым, они банально быстрее». Здесь живёт первая
// половина симбиоза; вторая (браузер) не тронута и остаётся откатом на каждом шаге.
//
// ⚠️ ЧТО ПРОВЕРЕНО ПРОБАМИ С ЭТОЙ МАШИНЫ (2026-09-10, повтор пробы владельца) — и почему список
// именно такой:
//
//   • `GET /api/comment/list/?aweme_id=<id>&count=20&cursor=0&aid=1988` — РАБОТАЕТ без подписи.
//     Отдаёт `comments[]` (`cid`, `text`, `create_time`, `digg_count`, `reply_comment_total`,
//     `user.unique_id`, `user.nickname`, иногда `reply_comment` — даровые ответы), `total`,
//     `has_more` (0/1), `cursor`. Замер: видео с 62 комментариями — 33 корня за 1,4 с двумя
//     страницами по 20. Браузером то же видео стоит десятки секунд.
//   • `GET /api/comment/list/reply/?item_id=<id>&comment_id=<cid>&count=20&cursor=0&aid=1988` —
//     РАБОТАЕТ, формат тот же, родителя ответ называет в `reply_id`.
//   • `GET https://www.tiktok.com/@<handle>` (HTML) — РАБОТАЕТ: 360 КБ, внутри
//     `__UNIVERSAL_DATA_FOR_REHYDRATION__` лежит `webapp.user-detail.userInfo` со счётчиками,
//     аватаром и `secUid`. ⚠️ СПИСКА ВИДЕО в SSR нет вовсе — он приезжает отдельным запросом.
//   • `api/user/detail/` и `api/post/item_list/` — ОТДАЮТ 200 И ПУСТОЕ ТЕЛО (0 байт): им нужна
//     подпись, которую TikTok считает в своём js. Значит СПИСОК ВИДЕО остаётся за браузером
//     целиком, и трогать его нельзя.
//
// 🔴 Прямой путь никогда не бросает исключений наружу: «не дал» — это признак `{ ok: false, why }`,
// а не беда. Решение «тогда браузером» принимает вызывающий, и оно должно приниматься одинаково
// на пустой ответ, на не-JSON, на `status_code != 0` и на ноль комментариев при непустом счётчике
// площадки. Последнее — самый важный случай: молчаливая пустота от TikTok выглядит как «у видео
// нет комментариев», и без этой проверки браузер не позвался бы вовсе, а строки бы пропали.
//
// ⚠️ Прямые запросы идут ВСЕГДА С ДОМАШНЕГО АДРЕСА: пул прокси (`proxies.mjs`) живёт в Playwright
// и на `fetch` не распространяется. Это не упущение — защита TikTok по адресу считает ЗАПУСКИ
// чистых профилей (`tiktok-gate.mjs`), а не обычные запросы страницы.
//
// Разбор вынесен в чистые функции (`parseComments`, `parseReplies`, `parseProfileHtml`) — их
// проверяют тесты `direct.test.mjs` на сохранённых кусках, сеть в тестах не трогается вовсе.

import { parseTikTokComments } from "./comments-tiktok.mjs";

/** Столько ждём один прямой запрос. Своё, короткое: браузерный откат ждёт минуты, этот — нет. */
export const DIRECT_TIMEOUT_MS = 15_000;
/** Столько комментариев в одной странице ответа: `count=20` — то же, что просит сама страница. */
export const DIRECT_PAGE = 20;
/** Потолок страниц одного списка — на случай, если `has_more` заклинит в единице. */
const MAX_PAGES = 50;
/** Заголовки пробы: десктопный Chrome, JSON и `Referer` на ту самую страницу. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.message ?? e).split("\n")[0];
const videoUrl = (handle, id) => `https://www.tiktok.com/@${String(handle ?? "").replace(/^@/, "")}/video/${id}`;
const profileUrl = (handle) => `https://www.tiktok.com/@${String(handle ?? "").replace(/^@/, "")}`;

/**
 * Один запрос со своим таймаутом. Отдаёт `{ ok, status, text, ms, why }` — исключений не бросает:
 * оборванная сеть здесь такой же «прямой не дал», как и пустое тело.
 */
async function hit(url, { referer, accept = "application/json", timeoutMs = DIRECT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const stop = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, {
      signal: stop,
      headers: {
        "User-Agent": UA,
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
        Referer: referer,
        Origin: "https://www.tiktok.com",
      },
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, status: res.status, text: "", ms, why: `ответ ${res.status}` };
    return { ok: true, status: res.status, text, ms, why: null };
  } catch (e) {
    return { ok: false, status: null, text: "", ms: Date.now() - started, why: short(e) };
  }
}

/**
 * Разбор одной страницы `/api/comment/list/`.
 * Отдаёт `{ ok, why, comments, replies, hasMore, cursor, total }`:
 *   • `comments` — корневые в общей форме сборщика (та же, что у браузерного пути);
 *   • `replies`  — ответы, которые TikTok положил ДАРОМ внутрь корневого (`reply_comment`);
 *   • `ok: false` — тело пустое, не JSON или `status_code != 0`. Тогда решает вызывающий.
 * ⚠️ Форму `comments[]` разбирает та же `parseTikTokComments`, что и браузерный путь: протокол
 * у них ОДИН, и второй разбор разошёлся бы с первым молча.
 * Чистая функция: её проверяют тесты.
 */
export function parseComments(text) {
  const empty = { comments: [], replies: [], hasMore: false, cursor: null, total: null };
  const raw = String(text ?? "");
  if (raw.trim() === "") return { ok: false, why: "пустое тело", ...empty };
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, why: "тело не JSON", ...empty };
  }
  // `status_code` у TikTok: 0 — всё в порядке, всё остальное — отказ (и текст в `status_msg`).
  const code = json?.status_code;
  if (code !== undefined && code !== null && Number(code) !== 0) {
    return { ok: false, why: `status_code ${code}${json?.status_msg ? `: ${String(json.status_msg).slice(0, 80)}` : ""}`, ...empty };
  }
  if (!Array.isArray(json?.comments)) return { ok: false, why: "в ответе нет comments[]", ...empty };
  const batch = parseTikTokComments(json);
  return {
    ok: true,
    why: null,
    // Корневые и ответы приезжают в одном списке только у ветки; в корневом списке всё корневое.
    comments: batch.comments.filter((c) => !c.parentId),
    replies: [...batch.comments.filter((c) => c.parentId), ...batch.replies],
    hasMore: batch.hasMore,
    cursor: batch.cursor,
    total: batch.total,
  };
}

/**
 * Разбор одной страницы `/api/comment/list/reply/` — формат тот же, но в `comments[]` лежат
 * ОТВЕТЫ, и родителя они называют сами (`reply_id`).
 * `parentId` — чей это список: им подписываются ответы, забывшие назвать родителя.
 * Отдаёт `{ ok, why, replies, hasMore, cursor, total }`. Чистая функция.
 */
export function parseReplies(text, parentId = null) {
  const one = parseComments(text);
  if (!one.ok) return { ok: false, why: one.why, replies: [], hasMore: false, cursor: null, total: null };
  const parent = parentId === null || parentId === undefined ? null : String(parentId);
  const replies = [...one.comments, ...one.replies]
    .map((c) => (c.parentId ? c : { ...c, parentId: parent }))
    // Третьего уровня у TikTok нет: у ответа своих ответов не бывает (см. `oneComment`).
    .map((c) => (c.parentId ? { ...c, replies: null } : c))
    .filter((c) => c.parentId);
  return { ok: true, why: null, replies, hasMore: one.hasMore, cursor: one.cursor, total: one.total };
}

/**
 * Счётчики профиля из HTML страницы `@handle`.
 * Отдаёт `{ ok, why, profile }`, где `profile` — та же форма, что отдаёт браузерный шаг списка
 * (`tiktok.mjs`), плюс `secUid`: он пригодится, если однажды найдётся способ подписать
 * `post/item_list`.
 * ⚠️ `statsV2` первым и здесь: в старом `stats.heartCount` у крупных креаторов переполнение.
 * Чистая функция.
 */
export function parseProfileHtml(html) {
  const raw = String(html ?? "");
  if (raw.trim() === "") return { ok: false, why: "пустой HTML", profile: null };
  const match = raw.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { ok: false, why: "в HTML нет __UNIVERSAL_DATA_FOR_REHYDRATION__", profile: null };
  let info = null;
  try {
    info = JSON.parse(match[1])?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo ?? null;
  } catch {
    return { ok: false, why: "данные страницы не разобрались", profile: null };
  }
  if (!info) return { ok: false, why: "на странице нет userInfo", profile: null };
  const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
  const s2 = info.statsV2 ?? {}, s1 = info.stats ?? {}, user = info.user ?? {};
  const followers = num(s2.followerCount ?? s1.followerCount);
  // Профиль без числа подписчиков — это не профиль, а обрезок: счётчики снимка были бы пустыми.
  if (followers === null) return { ok: false, why: "в userInfo нет счётчиков", profile: null };
  return {
    ok: true,
    why: null,
    profile: {
      followers,
      following: num(s2.followingCount ?? s1.followingCount),
      likesTotal: num(s2.heartCount ?? s2.heart ?? s1.heartCount),
      videosCount: num(s2.videoCount ?? s1.videoCount),
      nickname: user.nickname || "",
      signature: user.signature || "",
      avatar: user.avatarLarger || user.avatarMedium || null,
      secUid: user.secUid || null,
    },
  };
}

/**
 * Комментарии одного видео прямым запросом: корневые страницами по 20, пока TikTok говорит
 * «есть ещё» и не набран потолок `max` (`AMESTAT_COMMENTS_MAX`).
 *
 * `expected` — счётчик комментариев из снимка площадки. Ноль корней при непустом счётчике —
 * «прямой не дал»: это ровно та молчаливая пустота, ради которой откат и заведён.
 * Отдаёт `{ ok, why, comments, pages, ms, total }` — исключений не бросает.
 */
export async function fetchComments(awemeId, handle, { max = 100, expected = null, pauseMs = 500, log } = {}) {
  const id = String(awemeId ?? "");
  if (!id) return { ok: false, why: "у видео нет id", comments: [], pages: 0, ms: 0, total: null };
  const referer = videoUrl(handle, id);
  const started = Date.now();
  const roots = new Map();
  const free = new Map();
  let cursor = 0, pages = 0, total = null;

  while (pages < MAX_PAGES && roots.size < max) {
    const url = `https://www.tiktok.com/api/comment/list/?aweme_id=${encodeURIComponent(id)}&count=${DIRECT_PAGE}&cursor=${cursor}&aid=1988`;
    const res = await hit(url, { referer });
    pages++;
    if (!res.ok) return { ok: false, why: res.why, comments: [], pages, ms: Date.now() - started, total };
    const batch = parseComments(res.text);
    if (!batch.ok) return { ok: false, why: batch.why, comments: [], pages, ms: Date.now() - started, total };
    for (const c of batch.comments) if (!roots.has(c.id)) roots.set(c.id, c);
    for (const r of batch.replies) if (r.parentId && !free.has(r.id)) free.set(r.id, r);
    if (batch.total !== null) total = batch.total;
    if (!batch.hasMore) break;
    // Курсор площадки, а не «страница × 20»: TikTok им и считает.
    cursor = batch.cursor === null ? cursor + DIRECT_PAGE : batch.cursor;
    if (pauseMs > 0) await sleep(pauseMs);
  }

  const ms = Date.now() - started;
  const want = Number(expected);
  // ⚠️ `total` площадки считает и ответы тоже, поэтому сверять его с числом корней нельзя:
  // у видео с 62 «комментариями» корней бывает 33. Отказом считается только ПУСТОТА.
  if (roots.size === 0 && Number.isFinite(want) && want > 0) {
    return { ok: false, why: `ноль комментариев при счётчике ${want}`, comments: [], pages, ms, total };
  }
  const list = [...roots.values()].slice(0, max);
  log?.(`    прямой запрос: корневых ${list.length} (страниц ${pages}, ${ms} мс, счётчик площадки ${total ?? "?"})`);
  return { ok: true, why: null, comments: list, free: [...free.values()], pages, ms, total };
}

/**
 * Ответы одной ветки прямым запросом. Потолок `max` — `AMESTAT_REPLIES_MAX`, свой у каждой ветки.
 * Отдаёт `{ ok, why, replies, pages, ms }` — исключений не бросает.
 */
export async function fetchReplies(awemeId, commentId, handle, { max = 20, pauseMs = 500 } = {}) {
  const id = String(awemeId ?? ""), cid = String(commentId ?? "");
  if (!id || !cid) return { ok: false, why: "нет id видео или комментария", replies: [], pages: 0, ms: 0 };
  const referer = videoUrl(handle, id);
  const started = Date.now();
  const out = new Map();
  let cursor = 0, pages = 0;

  while (pages < MAX_PAGES && out.size < max) {
    const url = `https://www.tiktok.com/api/comment/list/reply/?item_id=${encodeURIComponent(id)}&comment_id=${encodeURIComponent(cid)}&count=${DIRECT_PAGE}&cursor=${cursor}&aid=1988`;
    const res = await hit(url, { referer });
    pages++;
    if (!res.ok) return { ok: false, why: res.why, replies: [], pages, ms: Date.now() - started };
    const batch = parseReplies(res.text, cid);
    if (!batch.ok) return { ok: false, why: batch.why, replies: [], pages, ms: Date.now() - started };
    for (const r of batch.replies) if (!out.has(r.id)) out.set(r.id, r);
    if (!batch.hasMore) break;
    cursor = batch.cursor === null ? cursor + DIRECT_PAGE : batch.cursor;
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { ok: true, why: null, replies: [...out.values()].slice(0, max), pages, ms: Date.now() - started };
}

/**
 * Счётчики профиля прямым запросом — HTML страницы `@handle`.
 * Отдаёт `{ ok, why, profile, ms }` — исключений не бросает.
 */
export async function fetchProfile(handle) {
  const who = String(handle ?? "").replace(/^@/, "");
  if (!who) return { ok: false, why: "пустой handle", profile: null, ms: 0 };
  const started = Date.now();
  const res = await hit(profileUrl(who), {
    referer: "https://www.tiktok.com/",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  if (!res.ok) return { ok: false, why: res.why, profile: null, ms: Date.now() - started };
  const parsed = parseProfileHtml(res.text);
  return { ok: parsed.ok, why: parsed.why, profile: parsed.profile, ms: Date.now() - started };
}

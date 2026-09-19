// Прямые запросы к Instagram — из вкладки браузера, под сессией фейкового аккаунта.
//
// Владелец, 2026-09-16: «нам точно нужно делать комбинированный обход, чтобы это, как и в случае
// с TikTok, сокращало время на каждый обход». Здесь первая половина симбиоза для Instagram;
// вторая (браузер: страница публикации, прокрутка, клики по веткам) не тронута и остаётся
// откатом на каждом видео — ровно как у TikTok (`direct.mjs`).
//
// ⚠️ ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ TIKTOK — и почему нельзя просто позвать `fetch` из Node:
//   • из Node Instagram не отвечает дважды: без браузерного окружения (проба 2026-09-10 с
//     cookies фейка — `status:fail`, HTML входа, 429) и через VPN (Node выходит адресом
//     Surfshark, гостю там на любой адрес `PolarisErrorRoot`, проба 2026-09-16);
//   • ИЗ ВКЛАДКИ instagram.com под сессией те же адреса отвечают JSON (проба 2026-09-16). Нужны
//     заголовки `X-IG-App-ID`, `X-CSRFToken` (cookie `csrftoken`) и `X-IG-WWW-Claim`
//     (`sessionStorage['www-claim-v2']`) — их страница держит сама. Поэтому браузер остаётся, но
//     только ЯКОРЕМ: одна лёгкая вкладка без прокруток, из которой и делаются запросы.
//
// ЧТО ПРОВЕРЕНО ПРОБАМИ (2026-09-16, публикация `@orandocom.naty` на 165 комментариев):
//   • `GET /api/v1/media/<pk>/comments/?can_support_threading=true&permalink_enabled=false` —
//     страницы по ~15 корневых, дальше `min_id=<next_min_id>` пока `has_more_headload_comments`
//     (или `max_id=<next_max_id>` пока `has_more_comments`). 9 страниц → 113 корневых, и с
//     даровыми ответами (`preview_child_comments`) сумма ровно `comment_count` 165;
//   • `GET /api/v1/media/<pk>/comments/<cid>/child_comments/` — ветка целиком, дальше
//     `max_id=<next_max_child_cursor>` пока `has_more_tail_child_comments`;
//   • `/api/v1/users/web_profile_info/` — 429 и под сессией: НЕ пользоваться;
//     `/api/v1/feed/user/<uid>/`, `POST /api/v1/clips/user/` — перенаправление на HTML.
//
// 🔴 Прямой путь никогда не бросает исключений наружу: «не дал» — это `{ ok: false, why }`, а
// решение «тогда браузером» принимает `sync.mjs`. Причины отказа — пустота при непустом счётчике,
// перенаправление на вход, 429, не-JSON, `status: fail` — все ведут к одному откату. Сессию и
// ограничение по-настоящему судит браузерный путь: у него на это свои правила
// (`comments-instagram.mjs`), и второй раз писать их здесь незачем.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { oneComment } from "./comments-instagram.mjs";
import { collectorDir } from "./env.mjs";

const APP_ID = "936619743392459";   // веб-приложение Instagram: его шлёт сама страница
// Якорь — страница настроек своего аккаунта: она лёгкая и при загрузке не зовёт ни ленту, ни
// истории, ни директ (главная и профиль зовут десяток запросов, которые нам не нужны).
const ANCHOR_URL = "https://www.instagram.com/accounts/edit/";
const NAV_TIMEOUT_MS = 45_000;
const CLAIM_WAIT_MS = 5_000;        // столько ждём, пока страница положит www-claim
const MAX_PAGES = 50;               // потолок страниц на видео и на ветку — как у TikTok

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortText = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 200);

/**
 * Разбор ответа запроса из страницы. На вход — то, что вернул `fetch` внутри вкладки:
 * `{ status, redirected, url, text }` или `{ error }`.
 * Отдаёт `{ ok, why, json }`. Чистая функция: её проверяют тесты.
 */
export function classifyIgResponse(res) {
  if (!res || res.error) return { ok: false, why: `request failed: ${res?.error ?? "no response"}`, json: null };
  const url = String(res.url ?? "");
  if (res.redirected && /\/accounts\/login|\/challenge|\/checkpoint/.test(url)) {
    return { ok: false, why: "redirected to login — the browser will check the session", json: null };
  }
  if (res.status === 429) return { ok: false, why: "Instagram rate-limited the requests (429)", json: null };
  if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}`, json: null };
  let json = null;
  try {
    json = JSON.parse(String(res.text ?? ""));
  } catch {
    return { ok: false, why: `response is not JSON${res.redirected ? " (redirected)" : ""}`, json: null };
  }
  if (!json || typeof json !== "object") return { ok: false, why: "empty response", json: null };
  if (json.status === "fail") return { ok: false, why: `refused: ${String(json.message ?? "no text").slice(0, 120)}`, json: null };
  return { ok: true, why: null, json };
}

/**
 * Одна страница корневых комментариев REST.
 * Отдаёт `{ ok, why, comments, replies, next, total }`: `comments` — корневые в форме сборщика,
 * `replies` — даровые ответы из `preview_child_comments` (родитель — этот корневой), `next` —
 * `{ param, value }` для следующей страницы или `null`, `total` — `comment_count` площадки
 * (корневые И ответы вместе). Чистая функция: её проверяют тесты.
 */
export function parseIgCommentsPage(json) {
  if (!Array.isArray(json?.comments)) return { ok: false, why: "no comments in response", comments: [], replies: [], next: null, total: null };
  const comments = [], replies = [];
  for (const node of json.comments) {
    const one = oneComment(node);
    if (!one) continue;
    comments.push(one);
    for (const child of node.preview_child_comments ?? []) {
      const reply = oneComment(child, one.id);
      if (reply?.parentId) replies.push(reply);
    }
  }
  // Instagram листает в обе стороны: «голова» (`min_id`) — то, что отдаёт первым, «хвост»
  // (`max_id`) — продолжение. На пробе вся публикация прошла головой, но хвост понимаем тоже.
  let next = null;
  if (json.has_more_headload_comments && json.next_min_id) next = { param: "min_id", value: String(json.next_min_id) };
  else if (json.has_more_comments && json.next_max_id) next = { param: "max_id", value: String(json.next_max_id) };
  const total = Number.isFinite(Number(json.comment_count)) ? Number(json.comment_count) : null;
  return { ok: true, why: null, comments, replies, next, total };
}

/**
 * Одна страница ветки ответов REST. `parentId` — id корневого: ответы без `parent_comment_id`
 * получают его. Отдаёт `{ ok, why, replies, next }`. Чистая функция: её проверяют тесты.
 */
export function parseIgChildPage(json, parentId) {
  if (!Array.isArray(json?.child_comments)) return { ok: false, why: "no child_comments in response", replies: [], next: null };
  const replies = [];
  for (const node of json.child_comments) {
    const one = oneComment(node, parentId === null || parentId === undefined ? null : String(parentId));
    if (one?.parentId) replies.push(one);
  }
  let next = null;
  if (json.has_more_tail_child_comments && json.next_max_child_cursor) next = { param: "max_id", value: String(json.next_max_child_cursor) };
  else if (json.has_more_head_child_comments && json.next_min_child_cursor) next = { param: "min_id", value: String(json.next_min_child_cursor) };
  return { ok: true, why: null, replies, next };
}

// ------------------------------------------------------------------ список: шаблоны GraphQL
// Ленту и Reels веб-клиент Instagram берёт только через `POST /graphql/query`; REST под веб-сессией
// закрыт (`feed/user/*` — перенаправление на главную, `POST clips/user/` — `feedback_required`,
// ЭТО СИГНАЛ БЛОКИРОВКИ ДЕЙСТВИЯ, адрес не трогать). Номер запроса (`doc_id`) и токены сессии
// (`fb_dtsg`, `lsd`) у запроса страницы свои, и собрать их руками нельзя — поэтому запрос
// страницы ЛОВИТСЯ целиком (шаблон) и повторяется со своими переменными (проба 2026-09-16 на
// `@instagram`): лента — `PolarisProfilePostsQuery` с другим `username`, следующая страница —
// тот же запрос с `after` и `first`; Reels — `PolarisProfileReelsTabContentQuery` с другим
// `target_user_id`, дальше так же `after` + `first`. `doc_id` и токены одни на все аккаунты,
// поэтому шаблон, пойманный на странице первого креатора обхода, годится для остальных.

export const FEED_QUERY = "PolarisProfilePostsQuery";
export const REELS_QUERY = "PolarisProfileReelsTabContentQuery";
const PAGE_COUNT = 12;   // столько отдаёт страница сама; больше не просим — не выделяться

// Заголовки, которые браузер ставит сам и из страницы их не передать (или не надо).
const SKIP_HEADERS = /^(cookie|content-length|content-type|host|origin|referer|sec-|accept-encoding|connection|user-agent)/i;

/**
 * Шаблон из пойманного запроса страницы: `{ url, headers, body }` или null, если это не запрос
 * `graphql/query` с переменными. На вход — простые поля запроса Playwright.
 * Чистая функция: её проверяют тесты.
 */
export function templateFromRequest({ url, method = "POST", headers = {}, postData = "" } = {}) {
  if (String(method).toUpperCase() !== "POST" || !/instagram\.com\/(graphql\/query|api\/graphql)/.test(String(url ?? ""))) return null;
  const body = Object.fromEntries(new URLSearchParams(String(postData ?? "")));
  if (!body.doc_id || !body.variables) return null;
  try {
    JSON.parse(body.variables);
  } catch {
    return null;
  }
  const kept = Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => !SKIP_HEADERS.test(k)));
  return { url: String(url), headers: kept, body };
}

/**
 * Переменные запроса ленты под другого креатора и другую страницу.
 * `after` — курсор площадки (`end_cursor`); null — первая страница.
 * Чистая функция: её проверяют тесты.
 */
export function feedVariables(templateVariables, { username, after = null, count = PAGE_COUNT } = {}) {
  const vars = JSON.parse(String(templateVariables));
  vars.username = String(username);
  delete vars.after;
  delete vars.first;
  if (after) {
    vars.after = String(after);
    vars.first = count;
  }
  return vars;
}

/**
 * Переменные запроса Reels под другого креатора и другую страницу. Id креатора в шаблоне стоит
 * в нескольких местах (`data.target_user_id`, `user_id`, у запроса продолжения ещё `id`) —
 * меняется везде, где есть, иначе площадка смешает двоих.
 * Чистая функция: её проверяют тесты.
 */
export function reelsVariables(templateVariables, { uid, after = null, count = PAGE_COUNT } = {}) {
  const vars = JSON.parse(String(templateVariables));
  const id = String(uid);
  if (vars.data && typeof vars.data === "object") vars.data.target_user_id = id;
  if ("user_id" in vars) vars.user_id = id;
  if ("id" in vars) vars.id = id;
  delete vars.after;
  delete vars.first;
  if (after) {
    vars.after = String(after);
    vars.first = count;
  }
  return vars;
}

/** Первая связка с `edges`, чьё имя подходит под `re`, где бы в ответе она ни лежала. */
function findConnection(value, re, depth = 0) {
  if (!value || typeof value !== "object" || depth > 40) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (re.test(key) && inner && typeof inner === "object" && Array.isArray(inner.edges)) return inner;
    const deeper = findConnection(inner, re, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/** Лента в ответе GraphQL (`xdt_api__v1__feed__user_timeline_graphql_connection`) или null. */
export const feedConnectionOf = (json) => findConnection(json, /feed__user_timeline/);

/** Reels в ответе GraphQL (`clips_connection`) или null. */
export const clipsConnectionOf = (json) => findConnection(json, /clips_connection|clips__user/);

/**
 * Просмотры из страницы Reels: `[{ code, pk, plays }]` — только у тех, у кого `play_count` есть.
 * Чистая функция: её проверяют тесты.
 */
export function playsFromClips(connection) {
  const out = [];
  for (const edge of connection?.edges ?? []) {
    const media = edge?.node?.media ?? edge?.node;
    const plays = media?.play_count;
    if (plays === null || plays === undefined || !Number.isFinite(Number(plays))) continue;
    out.push({ code: media.code ? String(media.code) : null, pk: media.pk ? String(media.pk) : null, plays: Number(plays) });
  }
  return out;
}

/**
 * Профиль из `GET /api/v1/users/<uid>/info/`: точные счётчики, имя, биография, аватар.
 * Отдаёт объект или null, если пользователя в ответе нет. Чистая функция: её проверяют тесты.
 */
export function profileFromInfo(json) {
  const u = json?.user;
  if (!u || !u.pk) return null;
  const n = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    uid: String(u.pk),
    username: String(u.username ?? ""),
    followers: n(u.follower_count),
    following: n(u.following_count),
    videosCount: n(u.media_count),
    nickname: String(u.full_name ?? ""),
    signature: String(u.biography ?? ""),
    avatar: u.hd_profile_pic_url_info?.url || u.profile_pic_url || null,
    isPrivate: u.is_private === true,
  };
}

/** Id креатора из ответа поиска (`/web/search/topsearch/`) — только при точном совпадении имени. */
export function uidFromSearch(json, handle) {
  const want = String(handle ?? "").replace(/^@/, "").toLowerCase();
  for (const item of json?.users ?? []) {
    const u = item?.user;
    if (u?.username && String(u.username).toLowerCase() === want && (u.pk || u.pk_id)) return String(u.pk ?? u.pk_id);
  }
  return null;
}

// Шаблоны живут в памяти, пока жив браузер полосы (ключ — его контекст), и в файле — между
// обходами (владелец, 2026-09-17: «хорошая идея, давай реализуем» — чтобы и первый креатор обхода
// шёл без своей страницы). Срока годности у файла нет намеренно: устаревший шаблон проверяется
// делом — прямой путь не даёт, креатор идёт страницей, страница ловит свежий шаблон и
// перезаписывает файл. Цена устаревшего — один неудачный запрос на обход.
// ⚠️ В файле токены сессии фейка (`fb_dtsg`, `lsd`) — поэтому он в `logs/`, а `collector/logs/`
// закрыт от git (`.gitignore` Amestat). Cookie сессии и так лежат на диске в `profile-opera/`.
export const TEMPLATES_FILE = resolve(collectorDir, "logs", "ig-templates.json");
const templateCache = new WeakMap();

/** Годится ли объект как шаблон: адрес, `doc_id` и разбираемые переменные. */
function validTemplate(tpl) {
  if (!tpl || typeof tpl !== "object" || typeof tpl.url !== "string") return false;
  if (!tpl.body || typeof tpl.body !== "object" || !tpl.body.doc_id || typeof tpl.body.variables !== "string") return false;
  try {
    JSON.parse(tpl.body.variables);
    return true;
  } catch {
    return false;
  }
}

/**
 * Шаблоны из содержимого файла: `{ feed, reels, savedAt }`, битое и чужое — `null` на своём месте.
 * Чистая функция: её проверяют тесты.
 */
export function templatesFromFile(json) {
  const pick = (tpl) => (validTemplate(tpl) ? { url: tpl.url, headers: tpl.headers && typeof tpl.headers === "object" ? tpl.headers : {}, body: tpl.body, capturedAt: Number(tpl.capturedAt) || null } : null);
  return { feed: pick(json?.feed), reels: pick(json?.reels), savedAt: Number(json?.savedAt) || null };
}

function loadTemplates() {
  try {
    return templatesFromFile(JSON.parse(readFileSync(TEMPLATES_FILE, "utf8")));
  } catch {
    // Файла нет или он испорчен — это не беда: первый креатор пойдёт страницей и шаблон поймает.
    return { feed: null, reels: null, savedAt: null };
  }
}

function saveTemplates(cache) {
  try {
    mkdirSync(dirname(TEMPLATES_FILE), { recursive: true });
    writeFileSync(TEMPLATES_FILE, JSON.stringify({ feed: cache.feed, reels: cache.reels, savedAt: Date.now() }, null, 2), "utf8");
  } catch {
    // Не записалось — следующий обход поймает шаблон страницей, как до файла. Работа не встаёт.
  }
}

/**
 * Шаблоны этого браузера: `{ feed, reels, fromFile }` (null — ещё не пойманы). Первый вызов на
 * браузер поднимает их из файла прошлых обходов. `log` — сказать, что шаблоны взяты оттуда.
 */
export function templatesFor(ctx, { log } = {}) {
  let cache = templateCache.get(ctx);
  if (!cache) {
    const saved = loadTemplates();
    cache = { feed: saved.feed, reels: saved.reels, fromFile: saved.feed !== null || saved.reels !== null };
    templateCache.set(ctx, cache);
    if (cache.fromFile) {
      const when = (tpl) => (tpl?.capturedAt ? new Date(tpl.capturedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "none");
      log?.(`  Instagram: request templates from a previous run (feed ${when(cache.feed)}, reels ${when(cache.reels)})`);
    }
  }
  return cache;
}

/**
 * Ловить шаблоны с этой страницы: первый запрос ленты и первый запрос Reels, какие она сделает
 * сама. Пойманное кладётся в `cache` и переживает страницу. Сам слушатель ничего не бросает.
 */
export function watchTemplates(page, cache) {
  page.on("request", (req) => {
    try {
      const name = req.headers()["x-fb-friendly-name"] ?? "";
      if (name !== FEED_QUERY && name !== REELS_QUERY) return;
      const tpl = templateFromRequest({ url: req.url(), method: req.method(), headers: req.headers(), postData: req.postData() ?? "" });
      if (!tpl) return;
      tpl.capturedAt = Date.now();
      if (name === FEED_QUERY) cache.feed = tpl;
      else cache.reels = tpl;
      // Свежий шаблон сразу в файл: им воспользуется и следующий обход.
      saveTemplates(cache);
    } catch {
      // Не поймали — значит этот креатор пройдёт прокруткой, как раньше.
    }
  });
}

/**
 * Повторить шаблон со своими переменными из страницы `page` (любой вкладки instagram.com под
 * сессией). Отдаёт то же, что `classifyIgResponse`. Исключений не бросает.
 */
export async function postTemplate(page, template, variables) {
  let res = null;
  try {
    res = await page.evaluate(async ({ url, headers, form }) => {
      // `csrftoken` берётся из cookie СЕЙЧАС, а не из шаблона: cookie между обходами меняется, и
      // токен из файла прошлого обхода сломал бы запрос, который иначе прошёл бы.
      const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1];
      const sent = { ...headers, ...(csrf ? { "x-csrftoken": csrf } : {}) };
      try {
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { ...sent, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString(),
        });
        return { status: r.status, redirected: r.redirected, url: r.url, text: await r.text() };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    }, { url: template.url, headers: template.headers, form: { ...template.body, variables: JSON.stringify(variables) } });
  } catch (e) {
    res = { error: shortText(e) };
  }
  const got = classifyIgResponse(res);
  // GraphQL отдаёт беды 200-м ответом с `errors` и пустой `data` — это тоже «не дал».
  if (got.ok && Array.isArray(got.json?.errors) && got.json.errors.length > 0 && !got.json.data) {
    return { ok: false, why: `GraphQL: ${String(got.json.errors[0]?.message ?? "error").slice(0, 120)}`, json: null };
  }
  return got;
}

/** Путь страницы: базовый адрес и параметр листания, если он есть. */
function withPage(path, next) {
  if (!next) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${next.param}=${encodeURIComponent(next.value)}`;
}

// Якорь один на браузер полосы: его делят список и комментарии всех креаторов обхода. Открытие
// стоит 1,5–3,5 с, и платить их на каждом шаге каждого креатора незачем. Закрывается вкладка
// вместе с браузером полосы (или явно — `close()`, тогда следующий вызов откроет новую).
const anchorCache = new WeakMap();

/**
 * Якорь: вкладка instagram.com под сессией, из которой идут все прямые запросы.
 * `ctx` — браузер полосы Instagram (постоянный профиль с сессией фейка).
 * Отдаёт `{ ok, why, get(path), post(template, variables), close() }` — исключений не бросает.
 * `get` и `post` отдают то же, что `classifyIgResponse`. Живой якорь этого браузера отдаётся
 * повторно, без нового открытия.
 * ⚠️ Попали на страницу входа — якорь не годится (`ok: false`), и работа идёт браузером: там
 * сессию разберут по своим правилам и скажут владельцу понятными словами.
 */
export async function openIgAnchor(ctx, { log } = {}) {
  const alive = anchorCache.get(ctx);
  if (alive?.isOpen()) return alive;
  let page = null;
  const close = async () => {
    if (!page) return;
    try {
      await page.close();
    } catch {
      // Вкладка могла закрыться сама вместе с браузером полосы.
    }
    page = null;
  };
  const started = Date.now();
  try {
    page = await ctx.newPage();
    await page.goto(ANCHOR_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    const where = new URL(page.url()).pathname;
    if (/^\/accounts\/login|^\/challenge|^\/checkpoint/.test(where)) {
      await close();
      return { ok: false, why: `anchor landed on ${where} — the browser will check the session`, get: null, close };
    }
    // www-claim страница кладёт после первого своего запроса; нет его — идём с «0», как она сама.
    for (let waited = 0; waited < CLAIM_WAIT_MS; waited += 250) {
      const claim = await page.evaluate(() => sessionStorage.getItem("www-claim-v2")).catch(() => null);
      if (claim) break;
      await sleep(250);
    }
  } catch (e) {
    await close();
    return { ok: false, why: `anchor did not open: ${shortText(e)}`, get: null, close };
  }
  log?.(`  Instagram: anchor tab for direct requests is open (${Date.now() - started} ms)`);

  const get = async (path) => {
    if (!page) return classifyIgResponse({ error: "anchor is closed" });
    let res = null;
    try {
      res = await page.evaluate(async ({ path, appId }) => {
        const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || "";
        const claim = sessionStorage.getItem("www-claim-v2") || "0";
        try {
          const r = await fetch(path, {
            credentials: "include",
            headers: { "X-IG-App-ID": appId, "X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf, "X-IG-WWW-Claim": claim },
          });
          return { status: r.status, redirected: r.redirected, url: r.url, text: await r.text() };
        } catch (e) {
          return { error: String(e?.message ?? e) };
        }
      }, { path, appId: APP_ID });
    } catch (e) {
      res = { error: shortText(e) };
    }
    return classifyIgResponse(res);
  };
  const post = (template, variables) => (page ? postTemplate(page, template, variables) : Promise.resolve(classifyIgResponse({ error: "anchor is closed" })));
  const isOpen = () => page !== null && !page.isClosed();
  const anchor = { ok: true, why: null, get, post, close, isOpen };
  anchorCache.set(ctx, anchor);
  return anchor;
}

/**
 * Корневые комментарии публикации прямым запросом, страницами, пока есть продолжение и не набран
 * потолок `max` (`AMESTAT_COMMENTS_MAX`).
 * `expected` — счётчик комментариев из снимка. Ноль корневых при непустом счётчике — «прямой не
 * дал»: та же молчаливая пустота, ради которой откат и заведён у TikTok.
 * Отдаёт `{ ok, why, comments, free, pages, ms, total }` — исключений не бросает. Форма ровно та
 * же, что у `fetchComments` TikTok: дальше с ней работает общий `directComments` в `sync.mjs`.
 */
export async function fetchIgComments(anchor, mediaId, { max = 100, expected = null, pauseMs = 500, log } = {}) {
  const id = String(mediaId ?? "");
  if (!id) return { ok: false, why: "post has no id", comments: [], pages: 0, ms: 0, total: null };
  const base = `/api/v1/media/${encodeURIComponent(id)}/comments/?can_support_threading=true&permalink_enabled=false`;
  const started = Date.now();
  const roots = new Map(), free = new Map();
  let next = null, pages = 0, total = null;
  const used = new Set();

  while (pages < MAX_PAGES && roots.size < max) {
    const res = await anchor.get(withPage(base, next));
    pages++;
    if (!res.ok) return { ok: false, why: res.why, comments: [], pages, ms: Date.now() - started, total };
    const batch = parseIgCommentsPage(res.json);
    if (!batch.ok) return { ok: false, why: batch.why, comments: [], pages, ms: Date.now() - started, total };
    for (const c of batch.comments) if (!roots.has(c.id)) roots.set(c.id, c);
    for (const r of batch.replies) if (!free.has(r.id)) free.set(r.id, r);
    if (batch.total !== null) total = batch.total;
    // Курсор, который уже был, — площадка пошла по кругу: дальше листать нечего.
    if (!batch.next || used.has(batch.next.value)) break;
    used.add(batch.next.value);
    next = batch.next;
    if (pauseMs > 0) await sleep(pauseMs);
  }

  const ms = Date.now() - started;
  const want = Number(expected);
  if (roots.size === 0 && Number.isFinite(want) && want > 0) {
    return { ok: false, why: `zero comments while the counter says ${want}`, comments: [], pages, ms, total };
  }
  const list = [...roots.values()].slice(0, max);
  // Сверка полноты: у Instagram счётчик = корневые + ответы, и её видно сразу, без веток.
  const promised = list.reduce((sum, c) => sum + Number(c.replies ?? 0), 0);
  const check = total === null ? "" : `, roots and replies by counters ${roots.size + promised} of ${total}`;
  log?.(`    direct request: roots ${list.length} (pages ${pages}, ${ms} ms, platform counter ${total ?? "?"}${check})`);
  return { ok: true, why: null, comments: list, free: [...free.values()], pages, ms, total };
}

/**
 * Ответы одной ветки прямым запросом. Потолок `max` — `AMESTAT_REPLIES_MAX`, свой у каждой ветки.
 * Отдаёт `{ ok, why, replies, pages, ms }` — исключений не бросает.
 */
export async function fetchIgReplies(anchor, mediaId, commentId, { max = 20, pauseMs = 500 } = {}) {
  const id = String(mediaId ?? ""), cid = String(commentId ?? "");
  if (!id || !cid) return { ok: false, why: "no post or comment id", replies: [], pages: 0, ms: 0 };
  const base = `/api/v1/media/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}/child_comments/`;
  const started = Date.now();
  const out = new Map();
  let next = null, pages = 0;
  const used = new Set();

  while (pages < MAX_PAGES && out.size < max) {
    const res = await anchor.get(withPage(base, next));
    pages++;
    if (!res.ok) return { ok: false, why: res.why, replies: [], pages, ms: Date.now() - started };
    const batch = parseIgChildPage(res.json, cid);
    if (!batch.ok) return { ok: false, why: batch.why, replies: [], pages, ms: Date.now() - started };
    for (const r of batch.replies) if (!out.has(r.id)) out.set(r.id, r);
    if (!batch.next || used.has(batch.next.value)) break;
    used.add(batch.next.value);
    next = batch.next;
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { ok: true, why: null, replies: [...out.values()].slice(0, max), pages, ms: Date.now() - started };
}

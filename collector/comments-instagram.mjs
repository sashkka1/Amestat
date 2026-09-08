// Тексты комментариев к одной публикации Instagram: страница `instagram.com/p/<code>/`
// открывается в профиле с сессией фейкового аккаунта, комментарии снимаются двумя путями —
// первые пятнадцать лежат прямо в HTML, остальные приезжают при прокрутке списка.
//
// Откуда что берётся (пробы 2026-09-08):
//   • первые 15 — в самой странице, в `<script type="application/json" data-sjs>`:
//     `RelayPrefetchedStreamCache` → … → `data.xdt_api__v1__media__media_id__comments__connection`;
//   • дальше — ответы `POST /api/graphql` с тем же `…comments__connection`. ⚠️ Именно
//     `/api/graphql`, а НЕ `/graphql/query`, которым ходит лента профиля: за шесть кругов
//     прокрутки `graphql/query` пришёл один раз и комментариев в нём не было вовсе.
//     Поэтому слушаем ВСЕ ответы instagram.com и смотрим на тело, а не на адрес;
//   • подгрузка идёт от прокрутки САМОГО списка (15 → 149 за восемь кругов). Кнопки «ещё»
//     под списком нет: ни одного svg с подходящим `aria-label` на странице не нашлось.
//
// Разметка обфусцирована, поэтому контейнер списка ищется по смыслу: единственный
// прокручиваемый предок, внутри которого больше всего элементов `<time>` (у каждого
// комментария он свой — «3 дн.»).
//
// Ответы на комментарии собираются тоже — в ту же таблицу, `parent_id` = id корневого
// (владелец, 2026-09-08). Берутся двумя путями:
//   • даром: часть ответов Instagram кладёт прямо в корневой, в `preview_child_comments`;
//   • кликом по «Смотреть все ответы (N)» / «View all N replies» под корневым — страница
//     отвечает `POST /api/graphql` со связкой `…comment_id__child_comments__connection`
//     (ключ содержит `child_comments`), где у узлов тот же вид, а родителя называет
//     `parent_comment_id`. Ловим тем же слушателем: он смотрит на тело, а не на адрес.
// Ветки раскрываются только у корневых, попавших в сбор (в пределах `AMESTAT_COMMENTS_MAX`),
// только если у корневого `replies > 0`, и не больше `AMESTAT_REPLIES_MAX` ответов на ветку.

import { expandBranches, pickReplies, branchesOf } from "./replies.mjs";
import { notice } from "./notices.mjs";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000;        // столько страница успевает отрисовать первые комментарии
const ROUNDS = 30;              // потолок кругов прокрутки списка
const STALE_ROUNDS = 4;         // столько кругов без прироста — значит список кончился
const ROUND_PAUSE_MS = 2_500;   // столько ждём догрузку после круга
const BRANCH_PAUSE_MS = 700;    // пауза между ветками

// Кнопки ветки. `data-e2e` у Instagram нет вовсе — разметка обфусцирована, ищем по подписи.
// ⚠️ «Показать ещё ответы» не должно сойти за «Смотреть все ответы», поэтому у раскрытия
// ветки стоит запрет на «ещё»: иначе одна и та же ветка считалась бы новой.
const BRANCH_OPEN = { selector: null, text: "^(?!.*(ещё|еще))(смотреть|посмотреть|показать)\\s+(все\\s+)?\\d*\\s*ответ|^view\\s+(all\\s+)?\\d*\\s*repl" };
const BRANCH_MORE = { selector: null, text: "(ещё|еще)\\s*(\\d+\\s*)?ответ|^view\\s+more\\s+repl" };

const RATE_TEXT = /Please wait a few minutes|Подождите несколько минут|Попробуйте (ещё раз )?позже|Try again later|challenge_required|checkpoint_required|Подтвердите, что это вы/i;
const MISSING_TEXT = /Sorry, this page isn'?t available|Извините, эта страница недоступна|К сожалению, эта страница недоступна|Страница недоступна/i;

// Те же слова, что в `instagram-web.mjs`: беда одна и та же, и владелец должен читать
// одинаковый текст, откуда бы он ни пришёл.
const ERR_SESSION = "Instagram: сессия фейкового аккаунта истекла — войди в Opera заново и сними копию профиля";
const ERR_LIMIT = "Instagram: площадка ограничила запросы, попробуй позже";

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/**
 * Все связки комментариев, какие есть в разобранном ответе: ключ содержит `comments__connection`
 * (у ветки ответов он же, только с приставкой — `…comment_id__child_comments__connection`)
 * или хотя бы `child_comments`: имена ключей Instagram меняет, а «child_comments» в них держится.
 */
function findConnections(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) findConnections(item, out);
    return out;
  }
  for (const [key, inner] of Object.entries(value)) {
    if ((key.includes("comments__connection") || key.includes("child_comments")) && Array.isArray(inner?.edges)) out.push(inner);
    else findConnections(inner, out);
  }
  return out;
}

/** Один комментарий в общей форме сборщика или null, если нет `pk` — ключа строки в базе. */
function oneComment(node, parentFallback = null) {
  const id = node?.pk ?? null;
  if (!id) return null;
  // У удалённых и закрытых авторов `user` пуст, а имя лежит в `fallback_user_info`.
  const user = node.user ?? node.fallback_user_info ?? {};
  const parent = node.parent_comment_id ? String(node.parent_comment_id) : parentFallback;
  return {
    id: String(id),
    parentId: parent,
    authorHandle: String(user.username ?? ""),
    authorName: String(user.full_name ?? ""),
    text: String(node.text ?? ""),
    likes: num(node.comment_like_count),
    // Третьего уровня у Instagram нет: у ответа своих ответов не бывает, в базе там `null`.
    replies: parent ? null : num(node.child_comment_count),
    createdAt: node.created_at ? new Date(Number(node.created_at) * 1000).toISOString() : null,
  };
}

/**
 * Разбор одной связки комментариев Instagram.
 * Отдаёт `{ comments, replies, endCursor, hasNext }`:
 *   • `comments` — узлы связки как пришли. У списка под публикацией это корневые
 *     (`parentId` = null), у связки ветки — ответы (`parentId` = id корневого); кто есть кто,
 *     разбирает вызывающий;
 *   • `replies` — ответы, которые Instagram кладёт ДАРОМ внутрь корневого,
 *     в `preview_child_comments`.
 */
export function parseInstagramComments(connection) {
  const comments = [], replies = [];
  for (const edge of connection?.edges ?? []) {
    const one = oneComment(edge?.node);
    if (!one) continue;
    comments.push(one);
    for (const child of edge.node.preview_child_comments ?? []) {
      const reply = oneComment(child, one.parentId ?? one.id);
      if (reply?.parentId) replies.push(reply);
    }
  }
  return {
    comments,
    replies,
    endCursor: connection?.page_info?.end_cursor ?? null,
    hasNext: connection?.page_info?.has_next_page !== false,
  };
}

/**
 * Комментарии из HTML страницы публикации (первые пятнадцать, без единого запроса).
 * Отдаёт массив связок; пусто — значит в странице их не оказалось.
 */
export function commentsFromHtml(html) {
  const out = [];
  const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(String(html ?? ""))) !== null) {
    if (!match[1].includes("comments__connection")) continue;
    try {
      findConnections(JSON.parse(match[1]), out);
    } catch {
      // Кусок мог оказаться не разбираемым — остальные всё равно проверяем.
    }
  }
  return out;
}

/**
 * Прокрутить список комментариев вниз. Отдаёт число `<time>` внутри найденного контейнера
 * (0 — контейнера нет, дальше листать бессмысленно).
 */
function scrollComments(page) {
  return page.evaluate(() => {
    let best = null, bestScore = 0;
    for (const el of document.querySelectorAll("div,section,main,ul")) {
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      const score = el.querySelectorAll("time").length;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (!best) return 0;
    best.scrollTop = best.scrollHeight;
    return bestScore;
  });
}

/**
 * Комментарии к одной публикации Instagram — корневые и ответы под ними.
 * `ctx` — уже открытый браузер на постоянном профиле (сессия фейка).
 * `video` — `{ id, url, creatorHandle }`; адрес должен вести на публикацию (`/p/…`, `/reel/…`).
 * Отдаёт массив `{ id, parentId, authorHandle, authorName, text, likes, replies, createdAt }`:
 * сначала корневые, следом ответы (`parentId` — id корневого, `replies` у них `null`).
 * При стене входа или ограничении бросает Error с русским текстом.
 */
export async function collectInstagramComments(ctx, video, { max = 100, repliesMax = 20, log } = {}) {
  const videoId = String(video?.id ?? "");
  const url = String(video?.url ?? "");
  if (!videoId || !url) throw new Error("у публикации нет id или адреса");
  if (!/\/(p|reel|tv)\//.test(url)) throw new Error(`адрес не ведёт на публикацию: ${url}`);
  const who = `${String(video?.creatorHandle ?? "").replace(/^@/, "") || "?"} публикация ${videoId}`;

  const page = await ctx.newPage();
  const seen = new Map();
  // Ответы копятся отдельно: их приносит и список корневых (`preview_child_comments`), и
  // раскрытая ветка, а `state.lastParent` — единственный способ узнать, какую ветку раскрыли.
  const state = { replies: new Map(), lastParent: null };
  let hasNext = true, limited = false, lostSession = false, bodies = 0;

  const take = (connections) => {
    for (const connection of connections) {
      const batch = parseInstagramComments(connection);
      let roots = 0, last = null;
      for (const c of batch.comments) {
        // Кто пришёл, видно по `parentId`, а не по ключу связки.
        if (c.parentId) {
          if (!state.replies.has(c.id)) state.replies.set(c.id, c);
          last = c.parentId;
        } else {
          roots++;
          if (!seen.has(c.id)) seen.set(c.id, c);
        }
      }
      for (const c of batch.replies) if (!state.replies.has(c.id)) state.replies.set(c.id, c);
      if (last) state.lastParent = last;
      // ⚠️ Конец списка объявляют только корневые: у ветки свой `page_info`, и им нельзя
      // оборвать прокрутку самого списка комментариев. Пустая связка веткой не считается —
      // это обычный конец корневого списка, и он остановку как раз объявляет.
      const branch = roots === 0 && batch.comments.length > 0;
      if (!branch && !batch.hasNext) hasNext = false;
    }
  };

  page.on("response", async (r) => {
    const link = r.url();
    if (!link.includes("instagram.com")) return;
    if (r.status() === 429) { limited = true; return; }
    let text = "";
    try {
      text = await r.text();
    } catch {
      // Ответ мог не дойти (страница ушла) — круг просто не даст прироста.
    }
    if (!text || !(text.includes("comments__connection") || text.includes("child_comments"))) return;
    if (/"login_required"/.test(text)) lostSession = true;
    bodies++;
    try {
      take(findConnections(JSON.parse(text)));
    } catch {
      // Не json — это сама страница; её разбирает `commentsFromHtml` ниже.
    }
  });

  try {
    let status = null;
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      status = res?.status() ?? null;
    } catch (e) {
      throw new Error(`страница публикации не открылась: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    if (status === 429) throw new Error(ERR_LIMIT);
    await page.waitForTimeout(SETTLE_MS);

    // Первые пятнадцать — прямо из страницы, без запроса.
    take(commentsFromHtml(await page.content()));

    const head = await page.evaluate(() => ({
      onLoginPage: location.pathname.startsWith("/accounts/login"),
      loginForm: !!document.querySelector('input[name="username"]'),
      bodyText: String(document.body.innerText ?? "").replace(/\s+/g, " ").slice(0, 1200),
    }));
    // ⚠️ Ни форма входа, ни пометка `login_required` сами по себе не означают потерянную
    // сессию: форму Instagram держит на странице публикации и у вошедшего, а
    // `login_required` приезжает в отдельных ответах при живой сессии (проба 2026-09-08:
    // пометка есть, а пятнадцать комментариев из страницы разобрались). Приговором это
    // становится, только когда собрать не удалось ничего.
    if (head.onLoginPage || ((lostSession || head.loginForm) && seen.size === 0)) {
      log?.(`    вход не подтвердился: адрес ${page.url()}, форма входа=${head.loginForm}, login_required=${lostSession}, комментариев ${seen.size}`);
      notice("session", `${who}: вход не подтвердился (форма входа=${head.loginForm}, login_required=${lostSession})`);
      throw new Error(ERR_SESSION);
    }
    // Признаки истёкшей сессии стоит знать и тогда, когда собрать всё-таки удалось: сегодня
    // прошло, завтра встанет.
    if (lostSession || head.loginForm) notice("session", `${who}: признаки истёкшей сессии, но комментарии собрались`);
    // Ограничение объявляем, только когда оно и правда помешало: пришедшие комментарии
    // сильнее одинокой пометки в чужом ответе.
    if ((limited || RATE_TEXT.test(head.bodyText)) && seen.size === 0) {
      notice("limit", `${who}: Instagram ограничил запросы`);
      throw new Error(ERR_LIMIT);
    }
    if (status === 404 || (MISSING_TEXT.test(head.bodyText) && seen.size === 0)) {
      throw new Error(`Instagram: публикация недоступна: ${url}`);
    }

    let stale = 0, rounds = 0, score = 0;
    for (; rounds < ROUNDS && hasNext && seen.size < max && stale < STALE_ROUNDS; rounds++) {
      const before = seen.size;
      score = await scrollComments(page);
      if (score === 0) break;
      await page.waitForTimeout(ROUND_PAUSE_MS);
      stale = seen.size === before ? stale + 1 : 0;
    }
    if (lostSession && seen.size === 0) {
      notice("session", `${who}: login_required и ни одного комментария`);
      throw new Error(ERR_SESSION);
    }

    log?.(`    публикация ${videoId}: комментариев ${seen.size}, тел ${bodies}, кругов ${rounds}${hasNext ? "" : " (список кончился)"}`);

    // Ответы: только под корневыми, попавшими в сбор, и только там, где они есть.
    const roots = [...seen.values()].slice(0, max);
    const branches = roots.filter((c) => (c.replies ?? 0) > 0).length;
    let opened = 0, moreClicks = 0, timedOut = false;
    if (branches > 0 && repliesMax > 0) {
      ({ opened, more: moreClicks, timedOut } = await expandBranches(page, state, {
        open: BRANCH_OPEN, more: BRANCH_MORE, branches, repliesMax, pauseMs: BRANCH_PAUSE_MS, log,
      }));
      if (timedOut) notice("replies", `${who}: на ветки не хватило времени, раскрыто ${opened} из ${branches}`);
    }
    const replies = pickReplies(state.replies.values(), roots, repliesMax);
    if (branches > 0) {
      log?.(`    ответов: собрано ${replies.length} у ${branchesOf(replies)} веток (раскрыто ${opened} из ${branches}, дожато ${moreClicks})`);
      if (replies.length === 0) notice("replies", `${who}: ответы не снялись ни у одной из ${branches} веток`);
    }
    return [...roots, ...replies];
  } finally {
    try {
      await page.close();
    } catch {
      // Вкладка могла закрыться сама вместе с браузером.
    }
  }
}

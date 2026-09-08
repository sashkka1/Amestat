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
// Ответы на комментарии не разворачиваем («Смотреть все ответы (2)» не нажимается): у
// корневого остаётся только их число. Если ответ всё же приехал сам, его `parent_comment_id`
// сохраняется как есть — таблица это умеет.

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000;        // столько страница успевает отрисовать первые комментарии
const ROUNDS = 30;              // потолок кругов прокрутки списка
const STALE_ROUNDS = 4;         // столько кругов без прироста — значит список кончился
const ROUND_PAUSE_MS = 2_500;   // столько ждём догрузку после круга

const RATE_TEXT = /Please wait a few minutes|Подождите несколько минут|Попробуйте (ещё раз )?позже|Try again later|challenge_required|checkpoint_required|Подтвердите, что это вы/i;
const MISSING_TEXT = /Sorry, this page isn'?t available|Извините, эта страница недоступна|К сожалению, эта страница недоступна|Страница недоступна/i;

// Те же слова, что в `instagram-web.mjs`: беда одна и та же, и владелец должен читать
// одинаковый текст, откуда бы он ни пришёл.
const ERR_SESSION = "Instagram: сессия фейкового аккаунта истекла — войди в Opera заново и сними копию профиля";
const ERR_LIMIT = "Instagram: площадка ограничила запросы, попробуй позже";

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/** Все связки комментариев, какие есть в разобранном ответе: ключ содержит `comments__connection`. */
function findConnections(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) findConnections(item, out);
    return out;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key.includes("comments__connection") && Array.isArray(inner?.edges)) out.push(inner);
    else findConnections(inner, out);
  }
  return out;
}

/**
 * Разбор одной связки комментариев Instagram.
 * Отдаёт `{ comments, endCursor, hasNext }`; `comments` — в общей форме сборщика.
 */
export function parseInstagramComments(connection) {
  const comments = [];
  for (const edge of connection?.edges ?? []) {
    const node = edge?.node;
    const id = node?.pk ?? null;
    if (!id) continue;
    // У удалённых и закрытых авторов `user` пуст, а имя лежит в `fallback_user_info`.
    const user = node.user ?? node.fallback_user_info ?? {};
    comments.push({
      id: String(id),
      parentId: node.parent_comment_id ? String(node.parent_comment_id) : null,
      authorHandle: String(user.username ?? ""),
      authorName: String(user.full_name ?? ""),
      text: String(node.text ?? ""),
      likes: num(node.comment_like_count),
      replies: num(node.child_comment_count),
      createdAt: node.created_at ? new Date(Number(node.created_at) * 1000).toISOString() : null,
    });
  }
  return {
    comments,
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
 * Комментарии к одной публикации Instagram.
 * `ctx` — уже открытый браузер на постоянном профиле (сессия фейка).
 * `video` — `{ id, url, creatorHandle }`; адрес должен вести на публикацию (`/p/…`, `/reel/…`).
 * Отдаёт массив `{ id, parentId, authorHandle, authorName, text, likes, replies, createdAt }`;
 * при стене входа или ограничении бросает Error с русским текстом.
 */
export async function collectInstagramComments(ctx, video, { max = 100, log } = {}) {
  const videoId = String(video?.id ?? "");
  const url = String(video?.url ?? "");
  if (!videoId || !url) throw new Error("у публикации нет id или адреса");
  if (!/\/(p|reel|tv)\//.test(url)) throw new Error(`адрес не ведёт на публикацию: ${url}`);

  const page = await ctx.newPage();
  const seen = new Map();
  let hasNext = true, limited = false, lostSession = false, bodies = 0;

  const take = (connections) => {
    for (const connection of connections) {
      const batch = parseInstagramComments(connection);
      for (const c of batch.comments) if (!seen.has(c.id)) seen.set(c.id, c);
      if (!batch.hasNext) hasNext = false;
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
    if (!text || !text.includes("comments__connection")) return;
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
      throw new Error(ERR_SESSION);
    }
    // Ограничение объявляем, только когда оно и правда помешало: пришедшие комментарии
    // сильнее одинокой пометки в чужом ответе.
    if ((limited || RATE_TEXT.test(head.bodyText)) && seen.size === 0) throw new Error(ERR_LIMIT);
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
    if (lostSession && seen.size === 0) throw new Error(ERR_SESSION);

    log?.(`    публикация ${videoId}: комментариев ${seen.size}, тел ${bodies}, кругов ${rounds}${hasNext ? "" : " (список кончился)"}`);
    return [...seen.values()].slice(0, max);
  } finally {
    try {
      await page.close();
    } catch {
      // Вкладка могла закрыться сама вместе с браузером.
    }
  }
}

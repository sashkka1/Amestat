// Сбор одного креатора Instagram браузером: страница профиля открывается в копии профиля
// Opera, где вошёл ФЕЙКОВЫЙ аккаунт, а данные снимаются с ответов `POST /graphql/query`,
// которые страница просит сама при прокрутке.
//
// Почему так, а не запросом к API: гостю Instagram показывает стену входа, а прямой
// `fetch('/api/v1/users/web_profile_info/…')` из страницы отвечает 429 с HTML даже под
// сессией (проба 2026-09-08). Поэтому мы ничего не просим сами — только слушаем.
//
// ⚠️ Профиль браузера здесь ПОСТОЯННЫЙ (`collector/profile-opera`), в отличие от TikTok:
// в нём живут cookies сессии, и стереть его — значит потерять вход. Отсюда же ограничение:
// один процесс на этой папке за раз, что даёт очередь обходов в `sync.mjs`.
//
// Откуда что берётся (проба 2026-09-08):
//   • лента — `data.xdt_api__v1__feed__user_timeline_graphql_connection`: pk, code, taken_at,
//     лайки, комментарии, `media_repost_count` (репосты). Просмотров в ленте НЕТ ни у кого;
//   • просмотры — вкладка `/<user>/reels/`, `data.fetch__XDTUserDict.clips_connection`:
//     там есть `play_count`, но нет дат. Склейка по `code`, запасной ключ — `pk`;
//   • счётчики профиля — из шапки страницы: SSR-json (`data-sjs`) описывает СМОТРЯЩЕГО,
//     то есть наш фейк, а не цель, и для счётчиков не годится вовсе. У крупных чисел полное
//     значение лежит в `title` («686 452 333»), видимый текст сокращён («686 млн»).
//     Запасной источник — meta-описание страницы; там подписчики тоже сокращены.
//
// Глубина (`depth`): 'all' — весь список до потолка, 'week' — только последние 7 дней.
// Список идёт от новых к старым, поэтому «неделя» — ранний выход, а не фильтр в конце;
// отфильтровать всё равно надо: в последней пачке приезжают старые соседи по странице.

// Браузер поднимается общим `launchProfile()` из `browser.mjs` — тем же, которым ходят за
// комментариями: там уже живут проверка профиля, свой срок на запуск и вторая попытка (Opera
// на хвосте предыдущего браузера встаёт через раз). Здесь окно скрытое: Instagram отдаёт всё
// и headless, в отличие от TikTok.
import { launchProfile, PROFILE_DIR } from "./browser.mjs";
import { notice } from "./notices.mjs";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 5_000;       // столько страница успевает попросить первую пачку
const FEED_ROUNDS = 40;        // потолок кругов прокрутки ленты
const REELS_ROUNDS = 10;       // потолок кругов на вкладке Reels
const STALE_ROUNDS = 8;        // столько кругов без прироста — значит список кончился
const MAX_POSTS = 200;         // дальше в прошлое не ходим
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Экраны и ответы, после которых собирать нечего. Проверяются в этом же порядке:
// ограничение и потерянный вход маскируются под «профиль не найден», если спутать очередь.
const RATE_TEXT = /Please wait a few minutes|Подождите несколько минут|Попробуйте (ещё раз )?позже|Try again later|challenge_required|checkpoint_required|Подтвердите, что это вы/i;
// В телах ответов ищем только машинные пометки: человеческая фраза приезжает в json и просто так.
const RATE_JSON = /Please wait a few minutes|"require_login"|checkpoint_required|challenge_required|rate_limit/i;
const MISSING_TEXT = /Sorry, this page isn'?t available|Извините, эта страница недоступна|К сожалению, эта страница недоступна|Страница недоступна/i;
const PRIVATE_TEXT = /This account is private|Аккаунт закрыт|закрытый аккаунт/i;

// Те же слова, что в `comments-instagram.mjs`: беда одна и та же, и владелец должен читать
// одинаковый текст, откуда бы он ни пришёл. ⚠️ Дубль намеренный — правишь здесь, правь и там.
const ERR_SESSION = "Instagram: сессия фейкового аккаунта истекла — войди в Opera заново и сними копию профиля";
const ERR_LIMIT = "Instagram: площадка ограничила запросы, попробуй позже";

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
/** Момент публикации в мс — для сортировки от новых к старым; без даты уходит в конец. */
const at = (v) => (v.publishedAt ? Date.parse(v.publishedAt) || 0 : 0);

/**
 * «686 452 333», «8 579», «8,579», «686 млн», «1,2 тыс.», «1.2M» → число.
 * Сокращение есть — запятая/точка отделяет дробную часть; сокращения нет — они разделяют
 * тысячи, и тогда все не-цифры выбрасываются.
 */
function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\u00a0/g, " ").trim().toLowerCase();
  if (!/\d/.test(s)) return null;
  const m = s.match(/^([\d\s.,]+?)\s*(тыс|млн|млрд|тис|k|m|b)?\.?$/i);
  if (!m) return null;
  const mult = { тыс: 1e3, тис: 1e3, млн: 1e6, млрд: 1e9, k: 1e3, m: 1e6, b: 1e9 }[m[2] ?? ""] ?? 1;
  const digits = m[1].replace(/\s/g, "");
  const value = mult === 1 ? Number(digits.replace(/[.,]/g, "")) : Number(digits.replace(",", ".")) * mult;
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** Строка сохраняется как источник, только если из неё вообще получается число. */
const keepNumeric = (raw) => (raw !== null && raw !== undefined && parseCount(raw) !== null ? String(raw).trim() : null);

/** Счётчики из текста вида «8 579 публикаций 686 млн подписчиков 286 подписок». */
function statsFromText(text) {
  const grab = (re) => {
    const m = String(text ?? "").replace(/\u00a0/g, " ").match(re);
    return m ? keepNumeric(m[1]) : null;
  };
  // Число начинается с цифры, иначе в него утекает запятая соседа («, 8 579»).
  // ⚠️ Слово ловится стемом, а не `\w*\b`: `\w` кириллицы не знает, и «публикац\w*\b»
  // на «публикаций» не срабатывает вовсе (проверено на тексте шапки из пробы).
  const n = "(\\d[\\d\\s.,]*(?:\\s*(?:тыс|млн|млрд|тис|K|M|B))?\\.?)\\s*";
  return {
    posts: grab(new RegExp(n + "(?:публикац|posts?\\b)", "i")),
    followers: grab(new RegExp(n + "(?:подписчик|followers?\\b)", "i")),
    following: grab(new RegExp(n + "(?:подписок|подписки|following\\b)", "i")),
  };
}

/** Счётчики из meta-описания вида «Подписчики: 686M, Подписки: 286, Публикации: 8,579». */
function statsFromLabels(text) {
  const out = { posts: null, followers: null, following: null };
  for (const part of String(text ?? "").replace(/\u00a0/g, " ").split(/,(?=\s*\D)|[–—]/)) {
    // Запятая внутри числа («8,579») список не разделяет — только та, за которой не цифра.
    const m = part.match(/^\s*([^:]+):\s*(\d[\d\s.,]*(?:\s*(?:тыс|млн|млрд|тис|K|M|B))?\.?)\s*$/i);
    if (!m) continue;
    const label = m[1].toLowerCase(), value = keepNumeric(m[2]);
    if (/публикац|posts?/.test(label)) out.posts ??= value;
    else if (/подписчик|followers?/.test(label)) out.followers ??= value;
    else if (/подписок|подписки|following/.test(label)) out.following ??= value;
  }
  return out;
}

/** Биография — из meta-описания: «… (@user) в Instagram: "текст"». Кавычек нет — биографии нет. */
function bioFromDescription(text) {
  const m = String(text ?? "").match(/["“«]([\s\S]*)["”»]\s*$/);
  return m ? m[1].trim() : "";
}

/** Полное имя из og:title вида «Instagram (@instagram) • Фото и видео в Instagram». */
function nameFromOgTitle(text) {
  const m = String(text ?? "").match(/^(.*?)\s*\(@/);
  return m ? m[1].trim() : "";
}

/** Всё, что видно на странице: состояние, точные числа из title, текст шапки, meta. */
function readHead(page) {
  return page.evaluate(() => {
    const nb = (s) => String(s ?? "").replace(/\u00a0/g, " ");
    const root = document.querySelector("header") || document.body;
    const KEY = { posts: /публикац|\bposts?\b/i, followers: /подписчик|\bfollowers?\b/i, following: /подписок|подписки|\bfollowing\b/i };
    // Полное значение крупного счётчика Instagram кладёт в title соседнего span.
    const exact = {};
    for (const el of root.querySelectorAll("[title]")) {
      const title = nb(el.getAttribute("title")).trim();
      if (!/^\d[\d\s.,]*$/.test(title)) continue;
      const near = nb(el.parentElement?.innerText ?? el.textContent);
      for (const [key, re] of Object.entries(KEY)) if (exact[key] === undefined && re.test(near)) exact[key] = title;
    }
    const meta = (sel) => document.querySelector(sel)?.getAttribute("content") ?? "";
    return {
      url: location.href,
      loginWall: !!document.querySelector('input[name="username"]') || location.pathname.startsWith("/accounts/login"),
      exact,
      headText: nb(root.innerText).replace(/\s+/g, " "),
      bodyText: nb(document.body.innerText).replace(/\s+/g, " ").slice(0, 1200),
      ogTitle: meta('meta[property="og:title"]'),
      ogImage: meta('meta[property="og:image"]'),
      ogDescription: meta('meta[property="og:description"]'),
      description: meta('meta[name="description"]'),
    };
  });
}

/** Счётчики профиля: точное число из title сильнее текста шапки, текст шапки — meta-описания. */
function pickStats(head) {
  const sources = [
    ["title в шапке", head.exact ?? {}],
    ["шапка", statsFromText(head.headText)],
    ["meta-описание", statsFromLabels(head.ogDescription || head.description)],
    ["meta-описание", statsFromText(head.ogDescription || head.description)],
  ];
  const out = {};
  for (const field of ["posts", "followers", "following"]) {
    out[field] = { value: null, from: "не нашлось", approx: false };
    for (const [from, stats] of sources) {
      const raw = keepNumeric(stats?.[field]);
      if (raw === null) continue;
      out[field] = { value: parseCount(raw), from, approx: /тыс|млн|млрд|тис|[kmb]/i.test(raw), raw };
      break;
    }
  }
  return out;
}

/**
 * Самая старая НЕзакреплённая публикация пачки, в мс эпохи (или null, если таких нет).
 * Закреплённые уходят в `pinned` и в проверке недели не участвуют: закреп висит первым со
 * своей старой датой и оборвал бы прокрутку на первой же пачке (владелец, 2026-09-08).
 * В результат закреплённая всё равно попадает — если её `taken_at` внутри недели.
 */
function oldestUnpinned(edges, pinned) {
  const times = [];
  for (const edge of edges ?? []) {
    const node = edge?.node;
    if (!node?.taken_at) continue;
    if ((node.timeline_pinned_user_ids ?? []).length > 0) {
      if (node.pk) pinned.add(String(node.pk));
      continue;
    }
    times.push(Number(node.taken_at) * 1000);
  }
  return times.length > 0 ? Math.min(...times) : null;
}

/** Прокрутка: колесо вниз и ожидание следующего ответа. Ответа нет — круг просто пустой. */
async function scrollRound(page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.mouse.wheel(0, 3000);
  try {
    await page.waitForResponse((r) => r.url().includes("/graphql/query"), { timeout: 6000 });
  } catch {
    // Ответа не дождались — это обычный конец списка.
  }
  await page.waitForTimeout(1200);
}

/**
 * Сбор креатора Instagram через браузер.
 * `creator` — строка из `creators` (нужен `handle`).
 * `depth` — 'all' (весь список до потолка) или 'week' (только последние 7 дней).
 * Отдаёт ту же форму, что и TikTok: `{ profile, videos }`; при беде — Error с русским текстом.
 */
export async function collectInstagramWeb(creator, { depth = "all", browserChoice = "", log } = {}) {
  const handle = String(creator?.handle ?? "").replace(/^@/, "");
  if (!handle) throw new Error("у креатора пустой handle");
  const since = depth === "week" ? Date.now() - WEEK_MS : null;

  // Нет профиля, не поднялся браузер — оба текста приходят из `launchProfile`; своих слов
  // добавляем ровно одно, чтобы в `sync_error` было видно площадку.
  let browser = null;
  try {
    browser = await launchProfile(browserChoice, { headless: true });
  } catch (e) {
    throw new Error(`Instagram: ${String(e?.message ?? e).split("\n")[0]}`);
  }
  const ctx = browser.ctx;

  try {
    log?.(`  браузер: ${browser.describe}, профиль ${PROFILE_DIR}`);
    // Отсутствие cookie `sessionid` — признак истёкшей сессии, но НЕ приговор сам по себе:
    // приговор выносится ниже, разом со всеми признаками и только на пустых руках.
    const noSession = !(await ctx.cookies("https://www.instagram.com")).some((c) => c.name === "sessionid");

    const page = await ctx.newPage();
    const posts = new Map();   // pk → узел ленты
    const plays = new Map();   // code и pk → play_count из Reels
    const pinned = new Set();  // pk закреплённых: они не участвуют в проверке недели
    let hasNext = true, reachedOld = false, limited = false, lostSession = false, reelsSeen = 0;

    page.on("response", async (r) => {
      const url = r.url();
      if (!url.includes("instagram.com")) return;
      if (r.status() === 429) { limited = true; return; }
      if (!url.includes("/graphql/query")) return;
      let text = "";
      try {
        text = await r.text();
      } catch {
        // Ответ мог не дойти (страница ушла) — круг просто не даст прироста.
      }
      if (!text) return;
      if (RATE_JSON.test(text)) limited = true;
      if (/"login_required"/.test(text)) lostSession = true;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      const feed = json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
      for (const edge of feed?.edges ?? []) {
        const node = edge?.node;
        if (!node?.pk) continue;
        const owner = node.user?.username;
        if (owner && owner.toLowerCase() !== handle.toLowerCase()) continue;
        posts.set(String(node.pk), node);
      }
      if (feed?.page_info?.has_next_page === false) hasNext = false;
      // Глубина «неделя»: самая старая незакреплённая публикация пачки старше границы —
      // дальше не листаем. Закреплённые считаются отдельно и остановку не вызывают.
      if (since !== null && (feed?.edges?.length ?? 0) > 0) {
        const oldest = oldestUnpinned(feed.edges, pinned);
        if (oldest !== null && oldest < since) reachedOld = true;
      }
      for (const edge of json?.data?.fetch__XDTUserDict?.clips_connection?.edges ?? []) {
        const media = edge?.node?.media;
        if (!media || media.play_count === null || media.play_count === undefined) continue;
        reelsSeen++;
        if (media.code) plays.set(String(media.code), Number(media.play_count));
        if (media.pk) plays.set(String(media.pk), Number(media.play_count));
      }
    });

    let status = null;
    try {
      const res = await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      status = res?.status() ?? null;
    } catch (e) {
      throw new Error(`Instagram: страница профиля @${handle} не открылась: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    if (status === 429) throw new Error(ERR_LIMIT);
    await page.waitForTimeout(SETTLE_MS);

    const head = await readHead(page);
    const stats = pickStats(head);
    // Собрать хоть что-нибудь — значит прочесть счётчики профиля или получить публикации.
    const gotSomething = () => posts.size > 0 || stats.followers.value !== null || stats.posts.value !== null;

    // ⚠️ Ни форма входа, ни пометка `login_required`, ни отсутствие cookie `sessionid` сами по
    // себе не означают потерянную сессию: форму Instagram держит на странице и у вошедшего, а
    // `login_required` приезжает в отдельных ответах при живой сессии (проба 2026-09-08 — та же
    // ложная тревога, что уже вылечена в `comments-instagram.mjs`). Приговором это становится,
    // только когда собрать не удалось ничего — ни профиля, ни публикаций.
    if ((noSession || lostSession || head.loginWall) && !gotSomething()) {
      log?.(`  вход не подтвердился: адрес ${head.url}, стена входа=${head.loginWall}, login_required=${lostSession}, cookie sessionid=${noSession ? "нет" : "есть"}, публикаций ${posts.size}`);
      notice("session", `@${handle}: вход не подтвердился (стена входа=${head.loginWall}, login_required=${lostSession}, cookie sessionid=${noSession ? "нет" : "есть"})`);
      throw new Error(ERR_SESSION);
    }
    // Признаки истёкшей сессии стоит знать и тогда, когда собрать всё-таки удалось: сегодня
    // прошло, завтра встанет.
    if (noSession || lostSession || head.loginWall) {
      notice("session", `@${handle}: признаки истёкшей сессии, но данные собрались (cookie sessionid=${noSession ? "нет" : "есть"}, login_required=${lostSession}, стена входа=${head.loginWall})`);
    }
    // Ограничение объявляем, только когда оно и правда помешало: одинокая пометка в чужом
    // ответе при пришедшей первой пачке — не повод объявить обход неудачным.
    if ((limited || RATE_TEXT.test(head.bodyText)) && posts.size === 0) {
      notice("limit", `@${handle}: Instagram ограничил запросы`);
      throw new Error(ERR_LIMIT);
    }
    // Те же слова могут стоять и в биографии живого профиля, поэтому текст экрана считается
    // приговором только когда лента пуста: у закрытого и несуществующего публикаций не бывает.
    if (status === 404 || (MISSING_TEXT.test(head.bodyText) && posts.size === 0)) throw new Error(`Instagram: профиль не найден: @${handle}`);
    if (PRIVATE_TEXT.test(head.bodyText) && posts.size === 0) throw new Error(`Instagram: закрытый профиль: @${handle}`);

    if (!gotSomething()) throw new Error(`Instagram: профиль не найден: @${handle}`);
    log?.(`  счётчики профиля: подписчики ${stats.followers.value ?? "?"} (${stats.followers.from}${stats.followers.approx ? ", ПРИБЛИЗИТЕЛЬНО" : ""}), подписки ${stats.following.value ?? "?"} (${stats.following.from}), публикаций ${stats.posts.value ?? "?"} (${stats.posts.from})`);

    // Лента: листаем до конца, до потолка или до первой публикации старше недели.
    let stale = 0;
    for (let i = 0; i < FEED_ROUNDS && hasNext && stale < STALE_ROUNDS && !reachedOld && posts.size < MAX_POSTS; i++) {
      const before = posts.size;
      await scrollRound(page);
      stale = posts.size === before ? stale + 1 : 0;
    }
    // Тот же порядок, что и до прокрутки: пометка в ответе — приговор только на пустых руках.
    if ((noSession || lostSession) && !gotSomething()) {
      notice("session", `@${handle}: после прокрутки не собралось ничего, вход не подтверждён`);
      throw new Error(ERR_SESSION);
    }
    if (limited && posts.size === 0) {
      notice("limit", `@${handle}: Instagram ограничил запросы (лента пуста)`);
      throw new Error(ERR_LIMIT);
    }

    const owner = [...posts.values()].find((n) => n.user?.username?.toLowerCase() === handle.toLowerCase())?.user ?? null;
    const profile = {
      followers: stats.followers.value,
      following: stats.following.value,
      likesTotal: null,                       // суммы лайков профиля Instagram не показывает вовсе
      videosCount: stats.posts.value,
      nickname: owner?.full_name || nameFromOgTitle(head.ogTitle) || handle,
      signature: bioFromDescription(head.description || head.ogDescription),
      avatar: owner?.hd_profile_pic_url_info?.url || owner?.profile_pic_url || head.ogImage || null,
    };

    const all = [...posts.values()]
      .map((n) => ({
        id: String(n.pk),
        code: n.code ?? null,
        productType: n.product_type ?? null,
        publishedAt: n.taken_at ? new Date(Number(n.taken_at) * 1000).toISOString() : null,
        caption: n.caption?.text || "",
        coverUrl: n.image_versions2?.candidates?.[0]?.url ?? null,
        // `videos.url` в базе NOT NULL: без `code` (бывает у скрытых) ставим профиль.
        url: n.code ? `https://www.instagram.com/p/${n.code}/` : `https://www.instagram.com/${handle}/`,
        durationS: num(n.video_duration),     // в ленте длительности нет — обычно останется null
        views: null,
        likes: num(n.like_count),
        comments: num(n.comment_count),
        shares: num(n.media_repost_count),
        saves: null,
      }))
      .sort((a, b) => at(b) - at(a))
      .slice(0, MAX_POSTS);

    // Неделя: в базу идёт только свежее, но «пришедшими» считаем всё, что отдал Instagram.
    const picked = since === null
      ? all
      : all.filter((v) => v.publishedAt !== null && Date.parse(v.publishedAt) >= since);
    log?.(`  публикаций пришло ${all.length}${hasNext ? "" : " (список кончился)"}${reachedOld ? " (прокрутка остановлена: пошли публикации старше недели)" : ""}`);
    if (since !== null) log?.(`  за неделю: ${picked.length} из ${all.length} пришедших`);
    if (since !== null) log?.(`  закреплённых пропущено: ${pinned.size}`);

    // Просмотры живут только на вкладке Reels — и только у клипов.
    const need = () => picked.filter((v) => v.productType === "clips" && plays.get(v.code) === undefined && plays.get(v.id) === undefined);
    const clips = need().length;
    let rounds = 0;
    if (clips > 0) {
      try {
        await page.goto(`https://www.instagram.com/${handle}/reels/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_MS);
        for (; rounds < REELS_ROUNDS && need().length > 0; rounds++) await scrollRound(page);
      } catch (e) {
        // Вкладка не открылась — публикации и счётчики уже собраны, теряем только просмотры.
        const text = String(e?.message ?? e).split("\n")[0];
        log?.(`  вкладка Reels не открылась: ${text}`);
        notice("list", `@${handle}: вкладка Reels не открылась — просмотров не будет (${text})`);
      }
    }
    for (const v of picked) v.views = plays.get(v.code) ?? plays.get(v.id) ?? null;
    const withViews = picked.filter((v) => v.views !== null).length;
    log?.(`  Reels: просмотры нашлись у ${withViews} из ${clips} клипов (кругов ${rounds}, роликов на вкладке ${reelsSeen})`);

    if (picked.length === 0 && since === null && (profile.videosCount ?? 0) > 0) {
      throw new Error(`Instagram: лента пуста при ${profile.videosCount} публикациях по профилю: @${handle}`);
    }
    // Служебные поля наружу не отдаём: форма ответа общая для всех площадок.
    const videos = picked.map(({ code, productType, ...v }) => v);
    return { profile, videos };
  } finally {
    // ⚠️ Профиль НЕ стирается: в нём вход фейкового аккаунта. Про это помнит сам `cleanup()`.
    // Вкладку закрываем сами: профиль постоянный, и незакрытая всплывёт при следующем запуске.
    await browser.cleanup();
  }
}

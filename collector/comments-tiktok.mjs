// Тексты комментариев к одному видео TikTok: страница видео открывается в профиле с сессией
// фейкового аккаунта, комментарии снимаются с ответов `/api/comment/list/`, которые страница
// просит сама — сначала при клике по вкладке «Комментарии», дальше при прокрутке списка.
//
// ⚠️ ГЛАВНОЕ, ради чего это написано именно так (пробы 2026-09-08):
//
//  1. Окно должно быть НАСТОЯЩИМ. В headless страница видео открывается, вкладка
//     «Комментарии» нажимается, но `comment/list` отвечает 200 с ПУСТЫМ телом, список
//     остаётся из серых заглушек (`TUXSkeletonRectangle`), и следом TikTok показывает
//     капчу-пазл. Тот же заход с `headless: false` — четыре ответа по 80–90 КБ, 80
//     комментариев, капчи нет вовсе. Поэтому браузер для этого шага поднимается с окном
//     (`launchProfile(..., { headless: false })`), а окно уводится за край экрана.
//  2. Тела читаются СЛУШАТЕЛЕМ, а не `page.route`. Перехват с `route.fetch()` переигрывает
//     запрос, одноразовый msToken сгорает — и приходит то же пустое тело плюс капча.
//  3. Прокручивать надо САМ список: колесо над правой панелью его не двигает. Ищем
//     прокручиваемого предка первого комментария (это `DivCommentMain`) и двигаем `scrollTop`.
//  4. Не всякий пост живёт по адресу `/video/<id>`: фотопосты-карусели TikTok адресует через
//     `/photo/<id>`, а на `/video/<id>` отвечает ошибкой (оба прогона 2026-09-08 на видео
//     7682811121417456929 у @toplombard_warszaw — `net::ERR_HTTP_RESPONSE_CODE_FAILURE`).
//     Поэтому неудачное открытие `/video/` — не приговор: тот же id пробуется по `/photo/`,
//     дальше всё как обычно. Комментарии фотопостов идут в ту же таблицу.
//
// Из DOM комментарии не читаются вовсе: в разметке нет `cid`, а без него строку не записать —
// ключ таблицы `(video_id, id)`. Разметка нужна только как признак «список отрисовался» и как
// кнопки веток.
//
// Ответы на комментарии (второй уровень) собираются тоже — в ту же таблицу, `parent_id` = id
// корневого (владелец, 2026-09-08). Берутся двумя путями:
//   • даром: TikTok кладёт первые ответы прямо в корневой комментарий, в `reply_comment`;
//   • кликом: кнопка «Просмотреть N ответов» под корневым заставляет страницу спросить
//     `GET /api/comment/list/reply/?comment_id=<cid>&item_id=<видео>&…` — тот же формат
//     `comments[]`, а родителя называет `reply_id`. Слушаем тем же слушателем, что и корневые.
// Ветки раскрываются только у корневых, попавших в сбор (в пределах `AMESTAT_COMMENTS_MAX`),
// только если у корневого `replies > 0`, и не больше `AMESTAT_REPLIES_MAX` ответов на ветку.

import { hideWindow } from "./browser.mjs";
import { expandBranches, pickReplies, branchesOf } from "./replies.mjs";
import { notice } from "./notices.mjs";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000;        // столько страница успевает встать на ноги после загрузки
const TAB_WAIT_MS = 15_000;     // столько ждём саму вкладку: правая панель рисуется не сразу
const FIRST_WAIT_MS = 20_000;   // столько ждём первую пачку после клика по вкладке
const ROUNDS = 40;              // потолок кругов прокрутки списка
const STALE_ROUNDS = 4;         // столько кругов без прироста — значит список кончился
const ROUND_WAIT_MS = 8_000;    // столько ждём ответ на круг прокрутки
const POST_WAIT_MS = 5_000;     // столько ждём сам пост на странице, прежде чем звать его пропавшим
const TAB_LABELS = ["Комментарии", "Comments"];
const COOKIE_LABELS = ["Разрешить все", "Allow all"];
const BRANCH_PAUSE_MS = 700;    // пауза между ветками: клики подряд TikTok не любит

// Кнопки ветки. ⚠️ Разобрано на живой странице 2026-09-08 (после обхода #39, где не открылась
// ни одна ветка): `data-e2e="view-more-1"` и `view-more-2` на странице НЕТ ВООБЩЕ — ни одного
// узла, — а подпись у TikTok не «Посмотреть», а «Просмотреть 7 ответов». Отсюда два исправления:
//   • раскрытие ветки — настоящий `<button>` внутри `DivViewRepliesContainer`
//     (`DivReplyContainer > DivViewMoreRepliesWrapper > DivViewRepliesContainer > button`),
//     подпись «Просмотреть N ответов» / «Просмотреть 1 ответ»;
//   • «ещё» внутри ветки — не кнопка, а `<span>` с подписью «Просмотреть еще 4» (через «е», без
//     слова «ответов»), в том же `DivViewRepliesContainer`, рядом со «Скрыть». Разметкой его не
//     отличить, поэтому у него только подпись.
// ⚠️ `button` в селекторе раскрытия — не украшение: «Просмотреть еще» лежит в том же контейнере,
// и без него раскрытие приняло бы дожатие соседней ветки за новую ветку.
// Старый `data-e2e` оставлен в селекторе первым на случай, если TikTok вернёт его назад; у
// дожатия разметки нет вовсе (`selector: null`), как у Instagram.
const BRANCH_OPEN = {
  selector: '[data-e2e="view-more-1"], [class*="DivViewRepliesContainer"] button',
  text: "^(просмотреть|посмотреть|смотреть|показать|view)\\s+(все\\s+|all\\s+)?\\d+\\s*(ответ|repl)",
};
const BRANCH_MORE = { selector: null, text: "^(просмотреть|посмотреть|показать)\\s+(ещё|еще)|^view\\s+(\\d+\\s*)?more" };

const STOP_SCREEN = /Передвиньте ползунок|совместить пазл|Drag the slider|puzzle|captcha|Verify to continue|Something went wrong/i;
const ITEM_SELECTOR = '[class*="DivCommentItemWrapper"], [data-e2e="comment-level-1"]';
// Признак «пост на странице есть»: плеер видео или контейнер просмотра (у фотопоста плеера нет).
const POST_SELECTOR = 'video, [data-e2e="video-detail"], [data-e2e="detail-photo"], [class*="DivBrowserModeContainer"], [class*="DivVideoContainer"]';

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/**
 * Один комментарий в общей форме сборщика или null, если писать его некуда (нет `cid`:
 * ключ таблицы — `(video_id, id)`).
 * `parentFallback` — чей это ответ, когда сам комментарий родителя не называет.
 */
function oneComment(c, parentFallback = null) {
  const id = c?.cid ?? null;
  if (!id) return null;
  const parent = c.reply_id && String(c.reply_id) !== "0" ? String(c.reply_id) : parentFallback;
  return {
    id: String(id),
    parentId: parent,
    authorHandle: String(c.user?.unique_id ?? ""),
    authorName: String(c.user?.nickname ?? ""),
    text: String(c.text ?? ""),
    likes: num(c.digg_count),
    // Третьего уровня у TikTok нет: у ответа своих ответов не бывает, и в базе там `null`.
    replies: parent ? null : num(c.reply_comment_total),
    createdAt: c.create_time ? new Date(Number(c.create_time) * 1000).toISOString() : null,
  };
}

/**
 * Разбор одного ответа `/api/comment/list/` или `/api/comment/list/reply/` — формат у них общий.
 * Отдаёт `{ comments, replies, hasMore, cursor, total }`:
 *   • `comments` — всё, что лежало в `comments[]`, как пришло. У корневого списка там корневые
 *     (`parentId` = null), у списка ветки — ответы (`parentId` = id корневого). Кто есть кто,
 *     разбирает вызывающий: разложить по спискам он умеет, а формат у обоих один;
 *   • `replies` — ответы, которые TikTok кладёт ДАРОМ внутрь корневого, в `reply_comment`.
 * ⚠️ `has_more` у TikTok — число 0/1, а не булево.
 */
export function parseTikTokComments(json) {
  const list = Array.isArray(json?.comments) ? json.comments : [];
  const comments = [], replies = [];
  for (const c of list) {
    const one = oneComment(c);
    if (!one) continue;
    comments.push(one);
    for (const r of Array.isArray(c.reply_comment) ? c.reply_comment : []) {
      const reply = oneComment(r, one.parentId ?? one.id);
      if (reply?.parentId) replies.push(reply);
    }
  }
  return {
    comments,
    replies,
    hasMore: json?.has_more === 1 || json?.has_more === true,
    cursor: num(json?.cursor),
    total: num(json?.total),
  };
}

/** Баннер про cookies закрывает правую панель — если он есть, соглашаемся и идём дальше. */
async function dismissCookies(page) {
  for (const label of COOKIE_LABELS) {
    const button = page.getByRole("button", { name: label });
    try {
      if ((await button.count()) === 0) continue;
      await button.first().click({ timeout: 3_000 });
      return true;
    } catch {
      // Баннер мог исчезнуть сам между проверкой и кликом — это не беда.
    }
  }
  return false;
}

/**
 * Тот же пост по адресу `/photo/<id>` — так TikTok адресует фотопосты-карусели.
 * Отдаёт null, если адреса не из чего собрать (нет ни `/video/<id>`, ни ника с id).
 */
export function photoUrl(url, video) {
  const link = String(url ?? "");
  if (/\/video\/\d+/.test(link)) return link.replace(/\/video\/(\d+)/, "/photo/$1");
  const handle = String(video?.creatorHandle ?? "").replace(/^@/, "");
  const id = String(video?.id ?? "");
  return handle && id ? `https://www.tiktok.com/@${handle}/photo/${id}` : null;
}

/**
 * Одно открытие адреса. Отдаёт `{ error, post }`: беда навигации (или null) и виден ли сам пост.
 * Сюда же уехали пауза на «встать на ноги» и баннер cookies — вторая попытка ждёт того же.
 */
async function openOnce(page, link) {
  try {
    const res = await page.goto(link, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    const status = res?.status() ?? null;
    if (status !== null && status >= 400) return { error: `ответ ${status}`, post: false };
  } catch (e) {
    return { error: String(e?.message ?? e).split("\n")[0], post: false };
  }
  await page.waitForTimeout(SETTLE_MS);
  await dismissCookies(page);
  let post = true;
  try {
    await page.waitForSelector(POST_SELECTOR, { state: "attached", timeout: POST_WAIT_MS });
  } catch {
    // Ни плеера, ни контейнера просмотра — страница открылась, а поста на ней нет.
    post = false;
  }
  return { error: null, post };
}

/**
 * Страница поста. Сначала `/video/<id>`; не открылась или поста на ней не видно — тот же id
 * по адресу `/photo/<id>` (см. пункт 4 в шапке файла). Отдаёт, каким адресом кончилось дело;
 * не открылось ничем — бросает ту же ошибку, что бросалась и раньше.
 * Экспортируется ради теста: живьём этот путь виден, только когда TikTok опять сломает адрес.
 */
export async function openPost(page, url, video, log) {
  const first = await openOnce(page, url);
  if (!first.error && first.post) return "/video/";
  const why = first.error ?? "поста на странице нет";
  const alt = photoUrl(url, video);
  if (!alt || alt === url) {
    if (first.error) throw new Error(`страница видео не открылась: ${why}`);
    return "/video/";   // адреса `/photo/` не из чего собрать — работаем с тем, что открылось
  }
  log?.(`    /video/ не открылся, пробую /photo/ (${why})`);
  notice("photo", `${video?.id ?? "видео"}: /video/ не открылся (${why}) — иду по /photo/`);
  const second = await openOnce(page, alt);
  if (!second.error) return "/photo/";
  if (first.error) throw new Error(`страница видео не открылась: ${why}; /photo/ тоже: ${second.error}`);
  // `/video/` всё-таки открывалась, просто без плеера, — возвращаемся к ней и пробуем как есть.
  log?.(`    /photo/ не открылся (${second.error}) — работаю с /video/`);
  await openOnce(page, url);
  return "/video/";
}

/**
 * Вкладка «Комментарии» в правой панели: по умолчанию панель стоит на «Вам может понравиться».
 * Правая панель рисуется не сразу, поэтому вкладку ЖДЁМ, а не спрашиваем один раз.
 * Отдаёт, чем открыли, или null — тогда дальше решают сами ответы.
 */
async function openCommentsTab(page, log) {
  const tries = [
    ['[data-e2e="comments"]', () => page.locator('[data-e2e="comments"]').filter({ visible: true }).first()],
    ...TAB_LABELS.map((label) => [`текст «${label}»`, () => page.getByText(label, { exact: true }).filter({ visible: true }).first()]),
    ['[data-e2e="comment-icon"]', () => page.locator('[data-e2e="comment-icon"]').filter({ visible: true }).first()],
  ];
  const until = Date.now() + TAB_WAIT_MS;
  let lastError = "не нашлась";
  while (Date.now() < until) {
    for (const [what, make] of tries) {
      try {
        const target = make();
        if ((await target.count()) === 0) continue;
        await target.click({ timeout: 4_000 });
        return what;
      } catch (e) {
        lastError = `${what}: ${String(e?.message ?? e).split("\n")[0]}`;
      }
    }
    await page.waitForTimeout(1_000);
  }
  log?.(`    вкладка комментариев не открылась (${lastError})`);
  return null;
}

/**
 * Прокрутить сам список комментариев вниз. Отдаёт true, если нашёлся прокручиваемый предок;
 * false значит «списка на странице нет» — дальше листать бессмысленно.
 */
function scrollList(page, itemSelector) {
  return page.evaluate((sel) => {
    const first = document.querySelector(sel);
    let el = first?.parentElement ?? null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) {
        el.scrollTop = el.scrollHeight;
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }, itemSelector);
}

/** Что видно на странице: капча, сколько строк списка отрисовано и сколько из них не заглушки. */
function readState(page, itemSelector, stopRe) {
  return page.evaluate(([sel, re]) => {
    const items = [...document.querySelectorAll(sel)];
    return {
      stopScreen: new RegExp(re, "i").test(document.body.innerText),
      items: items.length,
      real: items.filter((el) => !el.querySelector(".TUXSkeletonRectangle")).length,
      // Первые слова экрана — единственная зацепка, когда вкладки не нашлось вовсе.
      head: String(document.body.innerText ?? "").replace(/\s+/g, " ").slice(0, 120),
    };
  }, [itemSelector, stopRe]);
}

/**
 * Комментарии к одному видео TikTok — корневые и ответы под ними.
 * `ctx` — уже открытый браузер на постоянном профиле (сессия фейка), С ОКНОМ: см. шапку файла.
 * `video` — `{ id, url, creatorHandle }`.
 * Отдаёт массив `{ id, parentId, authorHandle, authorName, text, likes, replies, createdAt }`:
 * сначала корневые, следом ответы (`parentId` — id корневого, `replies` у них `null`).
 * При капче или пустых ответах бросает Error с русским текстом.
 */
export async function collectTikTokComments(ctx, video, { max = 100, repliesMax = 20, expandReplies = true, profile = "profile-tiktok", log } = {}) {
  const videoId = String(video?.id ?? "");
  const url = String(video?.url ?? "");
  if (!videoId || !url) throw new Error("у видео нет id или адреса");
  const who = `${String(video?.creatorHandle ?? "").replace(/^@/, "") || "?"} видео ${videoId}`;

  const page = await ctx.newPage();
  // Новая вкладка открывает окно заново — уводим его за край экрана сразу, до навигации:
  // окно тут настоящее (иначе TikTok не отдаёт комментарии), но видеть его владелец не должен.
  await hideWindow(ctx, page, { log });
  const seen = new Map();
  // Ответы копятся отдельно: их приносит и корневой список (`reply_comment`), и раскрытая ветка,
  // а `state.lastParent` — единственный способ узнать, какую ветку мы только что раскрыли.
  const state = { replies: new Map(), lastParent: null };
  let hasMore = true, bodies = 0, empty = 0, replyBodies = 0;

  page.on("response", async (r) => {
    const link = r.url();
    // ⚠️ Адрес ветки СОДЕРЖИТ адрес корневого списка (`/comment/list/reply/`), поэтому сначала он.
    const isReply = link.includes("/api/comment/list/reply/");
    if (!isReply && !link.includes("/api/comment/list/")) return;
    // На странице видео TikTok заранее просит комментарии и к соседнему ролику — чужие нам не нужны.
    // У ветки id видео лежит в `item_id`; нет его в адресе вовсе — ответ всё равно наш:
    // ветку просили мы, со своей страницы, и заранее их никто не подгружает.
    if (isReply) {
      if (link.includes("item_id=") && !link.includes(`item_id=${videoId}`)) return;
    } else if (!link.includes(`aweme_id=${videoId}`)) return;
    if (isReply) replyBodies++; else bodies++;
    let text = "";
    try {
      text = await r.text();
    } catch {
      // Ответ мог не дойти (страница ушла) — круг просто не даст прироста.
    }
    if (!text) { if (!isReply) empty++; return; }
    try {
      const batch = parseTikTokComments(JSON.parse(text));
      for (const c of batch.comments) {
        // Кто пришёл, видно по `parentId`, а не по адресу: в ветке приезжают ответы,
        // в корневом списке — корневые.
        if (c.parentId) {
          if (!state.replies.has(c.id)) state.replies.set(c.id, c);
        } else if (!isReply && !seen.has(c.id)) {
          seen.set(c.id, c);
        }
      }
      for (const c of batch.replies) if (!state.replies.has(c.id)) state.replies.set(c.id, c);
      if (!isReply && !batch.hasMore) hasMore = false;   // конец списка объявляют только корневые
      // Чья это была ветка, знает только сам ответ: в разметке id комментария нет.
      const last = isReply ? batch.comments.filter((c) => c.parentId).at(-1) : null;
      if (last) state.lastParent = last.parentId;
    } catch {
      if (!isReply) empty++;
    }
  });

  try {
    const where = await openPost(page, url, video, log);
    let opened = await openCommentsTab(page, log);
    if (!opened) {
      // Первая страница после запуска браузера открывается «холодной»: правой панели нет
      // вовсе и ждать её бесполезно (живой обход 2026-09-08 потерял так первое видео).
      // Перезагрузка её ставит на место.
      log?.("    правой панели нет — перезагружаю страницу и пробую ещё раз");
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      } catch {
        // Не перезагрузилась — дальше решает вторая попытка открыть вкладку.
      }
      await page.waitForTimeout(SETTLE_MS);
      await dismissCookies(page);
      opened = await openCommentsTab(page, log);
    }

    // Первая пачка: ждём либо ответ, либо отрисованный список — что случится раньше.
    const until = Date.now() + FIRST_WAIT_MS;
    // `view` — что видно на экране; `state` выше — что уже собрано. Путать их нельзя.
    let view = await readState(page, ITEM_SELECTOR, STOP_SCREEN.source);
    while (Date.now() < until && seen.size === 0 && !view.stopScreen) {
      await page.waitForTimeout(1_500);
      view = await readState(page, ITEM_SELECTOR, STOP_SCREEN.source);
    }

    // Дальше — прокрутка самого списка, пока TikTok говорит «есть ещё» и есть прирост.
    let stale = 0, rounds = 0;
    for (; rounds < ROUNDS && hasMore && seen.size > 0 && seen.size < max && stale < STALE_ROUNDS; rounds++) {
      const before = seen.size;
      const moved = await scrollList(page, ITEM_SELECTOR);
      if (!moved) break;
      try {
        // Ответы веток здесь не в счёт: круг прокрутки ждёт следующую пачку корневых.
        await page.waitForResponse((r) => r.url().includes("/api/comment/list/") && !r.url().includes("/comment/list/reply/"), { timeout: ROUND_WAIT_MS });
      } catch {
        // Ответа не дождались — обычный конец списка, круг просто считается пустым.
      }
      await page.waitForTimeout(800);
      stale = seen.size === before ? stale + 1 : 0;
    }

    view = await readState(page, ITEM_SELECTOR, STOP_SCREEN.source);
    log?.(`    видео ${videoId}: комментариев ${seen.size}, тел ${bodies} (пустых ${empty}), кругов ${rounds}, строк в списке ${view.real}/${view.items}, вкладка ${opened ?? "не открылась"}, адрес ${where}${view.stopScreen ? ", СТОП-ЭКРАН" : ""}`);

    if (seen.size === 0) {
      if (view.stopScreen) {
        notice("stop", `${who}: TikTok показал капчу`);
        throw new Error(`TikTok показал капчу на видео ${videoId}`);
      }
      // Пустые тела при отрисованных заглушках — та же капча, только ещё не показанная.
      // ⚠️ Код здесь `session`, а не `stop`, и профиль назван нарочно: копий постоянного
      // профиля две (`profile-opera` и `profile-tiktok`), сессия фейка в них живёт своей
      // жизнью, и владелец должен видеть, в КАКОЙ из них кончился вход.
      if (bodies > 0 && empty === bodies) {
        notice("session", `${profile}: ${who} — ${bodies} пустых ответов на комментарии (сессия фейка в этой копии профиля истекла? окно скрыто?)`);
        throw new Error(`TikTok отдал ${bodies} пустых ответов на комментарии видео ${videoId} (профиль ${profile}: сессия истекла или окно скрыто)`);
      }
      if (bodies === 0) throw new Error(`TikTok не запросил комментарии видео ${videoId}: вкладка ${opened ?? "не открылась"}, на экране «${view.head}»`);
    }

    // Ответы: только под корневыми, попавшими в сбор, и только там, где они есть.
    const roots = [...seen.values()].slice(0, max);
    const branches = roots.filter((c) => (c.replies ?? 0) > 0).length;
    let branchesOpened = 0, moreClicks = 0, timedOut = false;
    // `expandReplies: false` (просьба «без веток») отменяет только КЛИКИ: ответы, которые
    // TikTok положил в корневой сам (`reply_comment`), уже собраны и ничего не стоили.
    if (branches > 0 && repliesMax > 0 && expandReplies) {
      ({ opened: branchesOpened, more: moreClicks, timedOut } = await expandBranches(page, state, {
        open: BRANCH_OPEN, more: BRANCH_MORE, branches, repliesMax, pauseMs: BRANCH_PAUSE_MS, log,
      }));
      if (timedOut) notice("replies", `${who}: на ветки не хватило времени, раскрыто ${branchesOpened} из ${branches}`);
    }
    const replies = pickReplies(state.replies.values(), roots, repliesMax);
    if (branches > 0) {
      log?.(`    ответов: собрано ${replies.length} у ${branchesOf(replies)} веток (${expandReplies ? `раскрыто ${branchesOpened} из ${branches}, дожато ${moreClicks}, тел ${replyBodies}` : "ветки не раскрывались — только даровые"})`);
      if (replies.length === 0 && expandReplies) notice("replies", `${who}: ответы не снялись ни у одной из ${branches} веток`);
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

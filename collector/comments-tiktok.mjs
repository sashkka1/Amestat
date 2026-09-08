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
//
// Из DOM комментарии не читаются вовсе: в разметке нет `cid`, а без него строку не записать —
// ключ таблицы `(video_id, id)`. Разметка нужна только как признак «список отрисовался».
//
// Ответы на комментарии (второй уровень) не собираются: у корневого остаётся только их число.

import { launchProfile } from "./browser.mjs";

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000;        // столько страница успевает встать на ноги после загрузки
const TAB_WAIT_MS = 15_000;     // столько ждём саму вкладку: правая панель рисуется не сразу
const FIRST_WAIT_MS = 20_000;   // столько ждём первую пачку после клика по вкладке
const ROUNDS = 40;              // потолок кругов прокрутки списка
const STALE_ROUNDS = 4;         // столько кругов без прироста — значит список кончился
const ROUND_WAIT_MS = 8_000;    // столько ждём ответ на круг прокрутки
const TAB_LABELS = ["Комментарии", "Comments"];
const COOKIE_LABELS = ["Разрешить все", "Allow all"];

const STOP_SCREEN = /Передвиньте ползунок|совместить пазл|Drag the slider|puzzle|captcha|Verify to continue|Something went wrong/i;
const ITEM_SELECTOR = '[class*="DivCommentItemWrapper"], [data-e2e="comment-level-1"]';

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/**
 * Разбор одного ответа `/api/comment/list/`.
 * Отдаёт `{ comments, hasMore, cursor, total }`; `comments` — уже в общей форме сборщика.
 * ⚠️ `has_more` у TikTok — число 0/1, а не булево.
 */
export function parseTikTokComments(json) {
  const list = Array.isArray(json?.comments) ? json.comments : [];
  const comments = [];
  for (const c of list) {
    const id = c?.cid ?? null;
    if (!id) continue;
    // В `comments[]` приезжают только корневые: у них `reply_id` = "0". Ответы лежат внутри
    // `reply_comment`, и мы их не разбираем — у корневого остаётся `replies` числом.
    const parent = c.reply_id && String(c.reply_id) !== "0" ? String(c.reply_id) : null;
    comments.push({
      id: String(id),
      parentId: parent,
      authorHandle: String(c.user?.unique_id ?? ""),
      authorName: String(c.user?.nickname ?? ""),
      text: String(c.text ?? ""),
      likes: num(c.digg_count),
      replies: num(c.reply_comment_total),
      createdAt: c.create_time ? new Date(Number(c.create_time) * 1000).toISOString() : null,
    });
  }
  return {
    comments,
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
 * Комментарии к одному видео TikTok.
 * `ctx` — уже открытый браузер на постоянном профиле (сессия фейка), С ОКНОМ: см. шапку файла.
 * `video` — `{ id, url, creatorHandle }`.
 * Отдаёт массив `{ id, parentId, authorHandle, authorName, text, likes, replies, createdAt }`;
 * при капче или пустых ответах бросает Error с русским текстом.
 */
export async function collectTikTokComments(ctx, video, { max = 100, log } = {}) {
  const videoId = String(video?.id ?? "");
  const url = String(video?.url ?? "");
  if (!videoId || !url) throw new Error("у видео нет id или адреса");

  const page = await ctx.newPage();
  const seen = new Map();
  let hasMore = true, bodies = 0, empty = 0;

  page.on("response", async (r) => {
    const link = r.url();
    if (!link.includes("/api/comment/list/")) return;
    // На странице видео TikTok заранее просит комментарии и к соседнему ролику — чужие нам не нужны.
    if (!link.includes(`aweme_id=${videoId}`)) return;
    bodies++;
    let text = "";
    try {
      text = await r.text();
    } catch {
      // Ответ мог не дойти (страница ушла) — круг просто не даст прироста.
    }
    if (!text) { empty++; return; }
    try {
      const batch = parseTikTokComments(JSON.parse(text));
      for (const c of batch.comments) if (!seen.has(c.id)) seen.set(c.id, c);
      if (!batch.hasMore) hasMore = false;
    } catch {
      empty++;
    }
  });

  try {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      throw new Error(`страница видео не открылась: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    await page.waitForTimeout(SETTLE_MS);
    await dismissCookies(page);
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
    let state = await readState(page, ITEM_SELECTOR, STOP_SCREEN.source);
    while (Date.now() < until && seen.size === 0 && !state.stopScreen) {
      await page.waitForTimeout(1_500);
      state = await readState(page, ITEM_SELECTOR, STOP_SCREEN.source);
    }

    // Дальше — прокрутка самого списка, пока TikTok говорит «есть ещё» и есть прирост.
    let stale = 0, rounds = 0;
    for (; rounds < ROUNDS && hasMore && seen.size > 0 && seen.size < max && stale < STALE_ROUNDS; rounds++) {
      const before = seen.size;
      const moved = await scrollList(page, ITEM_SELECTOR);
      if (!moved) break;
      try {
        await page.waitForResponse((r) => r.url().includes("/api/comment/list/"), { timeout: ROUND_WAIT_MS });
      } catch {
        // Ответа не дождались — обычный конец списка, круг просто считается пустым.
      }
      await page.waitForTimeout(800);
      stale = seen.size === before ? stale + 1 : 0;
    }

    state = await readState(page, ITEM_SELECTOR, STOP_SCREEN.source);
    log?.(`    видео ${videoId}: комментариев ${seen.size}, ответов ${bodies} (пустых ${empty}), кругов ${rounds}, строк в списке ${state.real}/${state.items}, вкладка ${opened ?? "не открылась"}${state.stopScreen ? ", СТОП-ЭКРАН" : ""}`);

    if (seen.size === 0) {
      if (state.stopScreen) throw new Error(`TikTok показал капчу на видео ${videoId}`);
      // Пустые тела при отрисованных заглушках — та же капча, только ещё не показанная.
      if (bodies > 0 && empty === bodies) {
        throw new Error(`TikTok отдал ${bodies} пустых ответов на комментарии видео ${videoId} (окно браузера скрыто?)`);
      }
      if (bodies === 0) throw new Error(`TikTok не запросил комментарии видео ${videoId}: вкладка ${opened ?? "не открылась"}, на экране «${state.head}»`);
    }
    return [...seen.values()].slice(0, max);
  } finally {
    try {
      await page.close();
    } catch {
      // Вкладка могла закрыться сама вместе с браузером.
    }
  }
}

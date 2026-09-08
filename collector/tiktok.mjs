// Сбор одного креатора TikTok: профиль из страницы, видео — из ответов `/api/post/item_list`,
// которые страница просит сама при прокрутке.
//
// Почему так, а не запросом к API: подписи запроса TikTok считает в своём js, повторить их
// снаружи нельзя. Поэтому мы просто листаем профиль браузером и слушаем, что он получает.
//
// ⚠️ Счётчики: `statsV2` — строки и они верные; в старом `stats.heartCount` у крупных
// креаторов переполнение (лайки приезжают отрицательными). Поэтому statsV2 первым.
//
// Глубина (`depth`): 'all' — весь список профиля, 'week' — только видео за последние 7 дней.
// Список TikTok отдаёт от новых к старым, поэтому «неделя» — не фильтр в конце, а ранний
// выход: как только в пришедшей пачке оказалось видео старше недели, дальше листать незачем.
// Отфильтровать всё равно надо: в последней пачке приезжают и старые соседи по странице.

import { launchFresh } from "./browser.mjs";

const PROFILE_TIMEOUT_MS = 45_000;
const SCROLL_ROUNDS = 80;      // потолок кругов прокрутки
const STALE_ROUNDS = 8;        // столько пустых кругов подряд — значит список кончился
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STOP_SCREEN = /Drag the slider|puzzle|captcha|Something went wrong|Verify to continue/i;

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Один заход браузером: свежий профиль, прокрутка до конца (или до первого видео старше
 * `since`), всё закрыть. `since` — граница в мс эпохи или null, если глубина 'all'.
 */
async function attempt(handle, { browserChoice, log, since = null }) {
  const { ctx, cleanup, describe } = await launchFresh(browserChoice);
  log?.(`  браузер: ${describe}`);
  try {
    const page = await ctx.newPage();
    const seen = new Map();
    let hasMore = true, responses = 0, empty = 0, reachedOld = false;
    page.on("response", async (r) => {
      if (!r.url().includes("/api/post/item_list")) return;
      let text = "";
      try {
        text = await r.text();
      } catch {
        // Ответ мог не дойти (страница ушла) — считаем его пустым, круг просто не даст прироста.
      }
      responses++;
      if (!text) { empty++; return; }
      try {
        const json = JSON.parse(text);
        const batch = json.itemList ?? [];
        for (const item of batch) seen.set(item.id, item);
        if (json.hasMore === false) hasMore = false;
        // Глубина «неделя»: самое старое видео пачки старше границы — дальше в прошлое не идём.
        if (since !== null && batch.length > 0) {
          const oldest = Math.min(...batch.map((i) => Number(i.createTime ?? 0) * 1000));
          if (Number.isFinite(oldest) && oldest < since) reachedOld = true;
        }
      } catch {
        empty++;
      }
    });

    try {
      await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: "domcontentloaded", timeout: PROFILE_TIMEOUT_MS });
    } catch (e) {
      throw new Error(`страница профиля @${handle} не открылась: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    await page.waitForTimeout(3500);

    const html = await page.content();
    const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    let info = null;
    try {
      info = match ? JSON.parse(match[1])?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo : null;
    } catch {
      info = null;
    }
    const stopScreen = await page.evaluate((re) => new RegExp(re, "i").test(document.body.innerText), STOP_SCREEN.source);
    if (!info) {
      throw new Error(stopScreen ? `стоп-экран TikTok на профиле @${handle}` : `профиль не найден: @${handle}`);
    }

    const s2 = info.statsV2 ?? {}, s1 = info.stats ?? {}, user = info.user ?? {};
    const profile = {
      followers: num(s2.followerCount ?? s1.followerCount),
      following: num(s2.followingCount ?? s1.followingCount),
      likesTotal: num(s2.heartCount ?? s2.heart ?? s1.heartCount),
      videosCount: num(s2.videoCount ?? s1.videoCount),
      nickname: user.nickname || handle,
      signature: user.signature || "",
      avatar: user.avatarLarger || user.avatarMedium || null,
    };

    let stale = 0;
    for (let i = 0; i < SCROLL_ROUNDS && hasMore && stale < STALE_ROUNDS && !reachedOld; i++) {
      const before = seen.size;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.mouse.wheel(0, 3000);
      try {
        await page.waitForResponse((r) => r.url().includes("/api/post/item_list"), { timeout: 6000 });
      } catch {
        // Ответа не дождались — это обычный конец списка, круг просто считается пустым.
      }
      await page.waitForTimeout(1000);
      stale = seen.size === before ? stale + 1 : 0;
    }

    const stopAfter = await page.evaluate((re) => new RegExp(re, "i").test(document.body.innerText), STOP_SCREEN.source);
    const all = [...seen.values()].map((v) => {
      const vs2 = v.statsV2 ?? {}, vs1 = v.stats ?? {};
      // Фотопост (карусель картинок) TikTok адресует как /photo/<id>: у него в ответе есть
      // `imagePost`, а страница /video/<id> не открывается — та же развилка, что в comments-tiktok.
      const isPhoto = !!v.imagePost;
      return {
        id: v.id,
        publishedAt: v.createTime ? new Date(Number(v.createTime) * 1000).toISOString() : null,
        caption: v.desc || "",
        coverUrl: v.video?.cover ?? v.imagePost?.images?.[0]?.imageURL?.urlList?.[0] ?? null,
        url: `https://www.tiktok.com/@${handle}/${isPhoto ? "photo" : "video"}/${v.id}`,
        durationS: v.video?.duration ?? null,
        views: num(vs2.playCount ?? vs1.playCount),
        likes: num(vs2.diggCount ?? vs1.diggCount),
        comments: num(vs2.commentCount ?? vs1.commentCount),
        shares: num(vs2.shareCount ?? vs1.shareCount),
        saves: num(vs2.collectCount ?? vs1.collectCount),
      };
    });
    // Неделя: в базу идёт только свежее, но «пришедшими» считаем всё, что отдал TikTok —
    // ноль видео за неделю у активного профиля повтором не лечится, а пустой ответ лечится.
    const videos = since === null
      ? all
      : all.filter((v) => v.publishedAt !== null && Date.parse(v.publishedAt) >= since);

    log?.(`  ответов item_list ${responses} (пустых ${empty}), видео ${all.length}, hasMore=${hasMore}, стоп-экран=${stopAfter}`);
    if (since !== null) log?.(`  за неделю: ${videos.length} из ${all.length} пришедших${reachedOld ? " (прокрутка остановлена: пошли видео старше недели)" : ""}`);
    return { profile, videos, rawCount: all.length, stopScreen: stopAfter };
  } finally {
    await cleanup();
  }
}

/**
 * Сбор креатора TikTok.
 * `creator` — строка из `creators` (нужен `handle`).
 * `depth` — 'all' (весь список) или 'week' (только последние 7 дней).
 * Отдаёт `{ profile, videos }`; при беде бросает Error с русским текстом.
 */
export async function collectTikTok(creator, { browserChoice = "", retryPauseMs = 20_000, depth = "all", log } = {}) {
  const handle = String(creator.handle || "").replace(/^@/, "");
  if (!handle) throw new Error("у креатора пустой handle");
  const since = depth === "week" ? Date.now() - WEEK_MS : null;

  const first = await attempt(handle, { browserChoice, log, since });
  // Решение о повторе — по пришедшим видео, а не по оставшимся после фильтра недели:
  // «за неделю ноль» бывает у живого профиля, который просто молчал, и повтор тут не поможет.
  const enough = first.rawCount > 0 || !first.profile.videosCount;
  if (enough) {
    if (first.rawCount === 0 && first.stopScreen) throw new Error(`стоп-экран TikTok у @${handle}`);
    return { profile: first.profile, videos: first.videos };
  }

  // Ноль видео при непустом профиле — обычно «выдохшийся» профиль браузера.
  // Одна повторная попытка в новом временном профиле, после паузы. Глубина та же.
  log?.(`  видео 0 при ${first.profile.videosCount} по профилю — повтор в новом профиле через ${Math.round(retryPauseMs / 1000)} с`);
  await sleep(retryPauseMs);
  const second = await attempt(handle, { browserChoice, log, since });
  if (second.rawCount === 0) {
    if (second.stopScreen) throw new Error(`стоп-экран TikTok у @${handle}`);
    throw new Error(`список видео пуст после двух попыток: @${handle} (по профилю ${second.profile.videosCount})`);
  }
  return { profile: second.profile, videos: second.videos };
}

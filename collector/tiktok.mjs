// Сбор одного креатора TikTok: профиль из страницы, видео — из ответов `/api/post/item_list`,
// которые страница просит сама при прокрутке.
//
// Почему так, а не запросом к API: подписи запроса TikTok считает в своём js, повторить их
// снаружи нельзя. Поэтому мы просто листаем профиль браузером и слушаем, что он получает.
//
// ⚠️ Счётчики: `statsV2` — строки и они верные; в старом `stats.heartCount` у крупных
// креаторов переполнение (лайки приезжают отрицательными). Поэтому statsV2 первым.
//
// Глубина (`depth`, миграция v18): 'all' — весь список профиля, 'week' — 7 дней, 'month' — 30,
// 'range' — выбранный период. Границы приходят готовыми (`bounds` от `depthBounds` в
// `scope.mjs`) — здесь дат не считают вовсе.
// Список TikTok отдаёт от новых к старым, поэтому нижняя граница — не фильтр в конце, а ранний
// выход: как только в пришедшей пачке оказалось видео старше её, дальше листать незачем.
// Отфильтровать всё равно надо: в последней пачке приезжают и старые соседи по странице.
// ⚠️ Верхняя граница (`until`, только у периода) прокрутку НЕ обрывает: свежие видео лежат в
// начале ленты, и сквозь них надо пройти. Но в базу они не идут.
//
// Охват (`scope.videos`, миграция v17): 'all' — как выше; 'ours' — листаем, пока не встретились
// все отслеживаемые видео креатора (наши и жёлтые), но не дольше `scope.maxPages` прокруток.
// ⚠️ Всё, что пришло в пролистанной части, кладётся в базу как обычно: снимок счётчиков достаётся
// даром вместе со списком. Правила остановки — чистые функции в `scope.mjs`.

import { launchFresh } from "./browser.mjs";
import { notice } from "./notices.mjs";
import { listStop, listRounds, missingTracked, filterDepth, depthBounds, depthWord } from "./scope.mjs";
import { HOME, looksLikeProxyTrouble } from "./proxies.mjs";

const PROFILE_TIMEOUT_MS = 45_000;
const SCROLL_ROUNDS = 80;      // потолок кругов прокрутки
const STALE_ROUNDS = 8;        // столько пустых кругов подряд — значит список кончился
const STOP_SCREEN = /Drag the slider|puzzle|captcha|Something went wrong|Verify to continue/i;

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/**
 * Один заход браузером: свежий профиль, прокрутка до конца (или до первого видео старше
 * `since`), всё закрыть. `since`/`until` — границы в мс эпохи или null, если границы нет.
 * `depth` нужен только на слово в строке лога («за неделю» / «за месяц» / «за период»).
 * `scope` — охват: `{ videos: 'all'|'ours', trackedIds, maxPages }`.
 */
async function attempt(handle, { browserChoice, log, since = null, until = null, depth = "all", scope = null, proxy = null }) {
  const mode = scope?.videos === "ours" ? "ours" : "all";
  const trackedIds = mode === "ours" ? scope?.trackedIds ?? [] : [];
  const rounds = listRounds(mode, scope?.maxPages, SCROLL_ROUNDS);
  const { ctx, cleanup, describe } = await launchFresh(browserChoice, { proxy, log });
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
        // Нижняя граница глубины: самое старое видео пачки старше её — дальше в прошлое не идём.
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
      if (stopScreen) notice("stop", `@${handle}: стоп-экран TikTok на странице профиля`);
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

    // Прокрутка. Решение «листать дальше или хватит» отдано `listStop`: при охвате «всё» это
    // прежнее правило (конец списка или видео старше недели), при «только наши» — «все
    // отслеживаемые встретились». Пустые круги (`stale`) обрывают прокрутку при любом охвате:
    // если список перестал расти, дальше его всё равно не будет.
    let stale = 0, pages = 0;
    for (; pages < rounds; pages++) {
      if (listStop({ mode, trackedIds, seenIds: [...seen.keys()], reachedOld, hasMore }).stop) break;
      if (stale >= STALE_ROUNDS) break;
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
    // Глубина: в базу идёт только то, что в неё попало, но «пришедшими» считаем всё, что отдал
    // TikTok — ноль видео за срок у активного профиля повтором не лечится, а пустой ответ лечится.
    // ⚠️ Нижнюю границу отслеживаемые видео переживают (за старыми нашими охват «только наши» и
    // листал), верхнюю — нет: период есть период.
    const videos = filterDepth(all, since, trackedIds, until);

    log?.(`  ответов item_list ${responses} (пустых ${empty}), видео ${all.length}, hasMore=${hasMore}, стоп-экран=${stopAfter}`);
    if (mode === "ours") {
      const missing = missingTracked(trackedIds, [...seen.keys()]);
      log?.(`  охват: только наши — отслеживаемых видео ${trackedIds.length}, найдено ${trackedIds.length - missing.length} за ${pages} прокруток`);
      if (missing.length > 0) {
        log?.(`  не найдено ${missing.length} наших/жёлтых видео за ${pages} прокруток`);
        notice("list", `@${handle}: не найдено ${missing.length} наших/жёлтых видео за ${pages} прокруток (охват «только наши»)`);
      }
    }
    if (since !== null || until !== null) {
      log?.(`  за ${depthWord(depth)}: ${videos.length} из ${all.length} пришедших${reachedOld && mode !== "ours" ? " (прокрутка остановлена: пошли видео старше границы)" : ""}${mode === "ours" && until === null ? " (с отслеживаемыми, они остаются при любой давности)" : ""}${until !== null ? " (видео свежее верхней границы не берём — даже отслеживаемые)" : ""}`);
    }
    return { profile, videos, rawCount: all.length, stopScreen: stopAfter };
  } finally {
    await cleanup();
  }
}

/**
 * Сбор креатора TikTok.
 * `creator` — строка из `creators` (нужен `handle`).
 * `depth` — 'all' | 'week' | 'month' | 'range'; нужен на слово в логе.
 * `bounds` — готовые границы `{ since, until }` от `depthBounds` (`scope.mjs`). Не переданы —
 * считаются здесь же из одной только глубины: так зовут разовые проверки (`proxy-check.mjs`).
 * `scope` — охват: `{ videos: 'all'|'ours', trackedIds, maxPages }`; при 'ours' прокрутка идёт
 * до тех пор, пока не встретятся все отслеживаемые видео креатора.
 * `pool` — пул адресов от `sync.mjs`: `{ take({ exclude }), bad(id, why), good(id) }`. Пусто —
 * идём с домашнего адреса без всякого лимита (так его зовут разовые проверки).
 *
 * ⚠️ Правило «без мгновенной второй попытки» (владелец, 2026-09-09) относится к ОДНОМУ И ТОМУ ЖЕ
 * адресу и никуда не делось: придержанному адресу и новый профиль ответит той же пустотой.
 * Адресов больше одного — беда другая: пустой список говорит про этот адрес, а не про весь
 * обход. Тогда адрес уходит в паузу (`pool.bad`) и делается ОДНА попытка со следующим здоровым —
 * не больше двух адресов на креатора, чтобы один недоступный креатор не сжёг весь пул.
 * Отдаёт `{ profile, videos }`; при беде бросает Error с русским текстом.
 */
export async function collectTikTok(creator, { browserChoice = "", depth = "all", bounds = null, scope = null, pool = null, log } = {}) {
  const handle = String(creator.handle || "").replace(/^@/, "");
  if (!handle) throw new Error("у креатора пустой handle");
  const { since, until } = bounds ?? depthBounds(depth);
  // Пула нет — адрес один, домашний, и второго круга не будет: `exclude` его же и исключает.
  const take = pool?.take ?? (async ({ exclude = [] } = {}) => (exclude.includes(HOME.id) ? null : { ...HOME }));

  const tried = [];
  let last = null;
  for (let round = 0; round < 2; round++) {
    const address = await take({ exclude: tried.map((a) => a.id) });
    // Годных адресов не осталось: на первом круге это отмена обхода, на втором — просто конец
    // попыток, и ниже сработает обычная ошибка «защита по адресу».
    if (!address) {
      if (tried.length === 0) throw new Error(`обход @${handle} отменён: свободного адреса нет`);
      break;
    }
    tried.push(address);

    let res = null;
    try {
      res = await attempt(handle, { browserChoice, log, since, until, depth, scope, proxy: address });
    } catch (e) {
      const text = String(e?.message ?? e).split("\n")[0];
      // Адрес не отозвался (прокси лежит, не пустил, оборвал) — это беда адреса, а не площадки:
      // в паузу его, чтобы следующий креатор не встал на те же грабли. Повтора здесь нет:
      // отличить «прокси лежит» от «интернета нет» мы не можем, и второй заход стоил бы запуска.
      if (looksLikeProxyTrouble(text)) pool?.bad?.(address.id, `ошибка соединения: ${text}`);
      throw e;
    }
    last = res;

    // Решение — по пришедшим видео, а не по оставшимся после фильтра недели: «за неделю ноль»
    // бывает у живого профиля, который просто молчал.
    if (res.rawCount > 0 || !res.profile.videosCount) {
      if (res.rawCount === 0 && res.stopScreen) {
        notice("stop", `@${handle}: стоп-экран TikTok`);
        throw new Error(`стоп-экран TikTok у @${handle}`);
      }
      pool?.good?.(address.id);
      return { profile: res.profile, videos: res.videos };
    }
    if (res.stopScreen) {
      notice("stop", `@${handle}: стоп-экран TikTok`);
      throw new Error(`стоп-экран TikTok у @${handle}`);
    }
    // Пустой список при непустом профиле — этот адрес придержан.
    pool?.bad?.(address.id, "TikTok не отдал список");
  }

  // Адрес был один — текст ошибки прежний, слово в слово. Пробовали несколько — перечисляем их:
  // владельцу важно видеть, что пусто пришло не с одного адреса.
  const where = tried.length > 1 ? `защита по адресу: ${tried.map((a) => a.label).join(", ")}` : "защита по адресу";
  const text = `TikTok не отдал список (${where}; по профилю ${last?.profile?.videosCount ?? "?"} видео)`;
  notice("list", `@${handle}: ${text}`);
  throw new Error(`${text}: @${handle}`);
}

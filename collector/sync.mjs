// Один обход: строка в `sync_runs`, сбор по каждому креатору, снимки в базу, итог.
//
// Правила, из которых собран порядок:
//   • Обход всегда оставляет след: строка `sync_runs` заводится ДО первого браузера и
//     закрывается в `finally`, чем бы дело ни кончилось. Иначе сайт вечно показывает «идёт».
//   • Ошибка одного креатора обход не валит: текст ложится в `creators.sync_error`,
//     счётчик `creators_failed` растёт, следующий креатор собирается как ни в чём не бывало.
//   • Один `taken_at` на креатора — снимок профиля и снимки всех его видео сделаны «в один миг»,
//     иначе разности за срок поедут.
//   • `videos.first_seen_at` и `videos.ours` сборщик не шлёт никогда: первое ставит база,
//     второе — триггер и владелец на сайте. Имя и описание креатора — тоже владельца.
//   • Одновременно идёт не больше одного обхода: TikTok и так на грани, а два браузера
//     на одного креатора гарантированно дают пустые ответы. ⚠️ ВНУТРИ обхода полос две —
//     см. следующий пункт; это не два обхода, а один в две руки.
//   • Полосы: креаторы делятся по площадке, и полоса TikTok идёт ОДНОВРЕМЕННО с полосой
//     Instagram (владелец, 2026-09-08: «два процесса, жрут больше ресурса, но эффективнее»).
//     Строка в `sync_runs` одна на обход, счётчики и лог общие; строки лога помечены `[tt]` и
//     `[ig]`, замечания — в одно письмо. Площадки друг другу не мешают: у каждой свои паузы,
//     свой браузер и своя копия профиля с сессией фейка.
//   • Браузер на постоянном профиле поднимается ОДИН РАЗ НА ПОЛОСУ и служит всем её креаторам:
//     Instagram'у — на ленту и на комментарии, TikTok'у — на комментарии (список видео у него
//     по-прежнему в чистом одноразовом профиле на креатора, и это правило не трогается).
//     ⚠️ Профилей поэтому два: одна папка держит один процесс браузера, а полос две
//     (`PROFILE_OPERA` и `PROFILE_TIKTOK`, копия заводится сама — см. `browser.mjs`).
//   • Глубина (`depth`) обхода целиком передаётся сборщикам площадок: 'all' — весь список
//     видео, 'week' — только за последние 7 дней. Снимок профиля делается всегда одинаково.
//   • Повтор после неудачи (`failedOnly`) берёт только тех, у кого в `creators.sync_error`
//     что-то есть: успевшие собраться второй раз за час не тревожатся.
//   • Тексты комментариев — отдельный шаг ПОСЛЕ снимков видео и только по свежим роликам
//     (`AMESTAT_COMMENTS_DAYS`, у которых комментарии вообще есть). Он ходит браузером полосы,
//     под сессией фейкового аккаунта, и ошибка на видео обход не валит: снимки уже записаны.
//     Два выключателя приходят из просьбы: `comments = false` — шага нет вовсе, `replies = false`
//     — корневые снимаются, а ветки не раскрываются (даровые ответы всё равно кладутся: они
//     приезжают внутри корневого и не стоят ни клика, ни запроса).
//   • Видео, у которого число комментариев не изменилось с прошлого съёма
//     (`videos.comments_synced_count`), второй раз не обходится вовсе: минуты уходили на то же
//     самое. Первый раз (там `null`) — снимаем всегда.
//   • Картинки Instagram на чужих адресах не остаются: аватар и обложки перекладываются в
//     свой бакет (`images.mjs`), в базу идёт наш публичный адрес. Причина — в `images.mjs`;
//     у TikTok картинки показываются как есть, и его это не касается вовсе.

import { get, patch, insertMany, insertReturning, upsert } from "./db.mjs";
import { loadEnv } from "./env.mjs";
import { collectTikTok } from "./tiktok.mjs";
import { collectInstagramGraph } from "./instagram-graph.mjs";
import { collectInstagramWeb } from "./instagram-web.mjs";
import { collectTikTokComments } from "./comments-tiktok.mjs";
import { collectInstagramComments } from "./comments-instagram.mjs";
import { launchProfile, trimTraffic, ensureProfileCopy, PROFILE_OPERA, PROFILE_TIKTOK } from "./browser.mjs";
import { rehostImage, isOurs, avatarPath, coverPath } from "./images.mjs";
import { notice, startRun, reportRun, takeSessionHints } from "./notices.mjs";
import { basename } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CREATOR_FIELDS = "id,platform,handle,display_name,avatar_custom,sort_order,added_at";
const COVERS_PARALLEL = 4;      // столько обложек качаем разом
const COVERS_PAUSE_MS = 100;    // и пауза между пачками: чужой CDN не любит очередь запросов подряд
const COMMENTS_PAUSE_MS = 3000; // пауза между видео на шаге комментариев
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOW_CREATOR_MS = 3 * 60_000;  // дольше — замечание владельцу: обход тормозит

// Куда странице комментариев вообще можно ходить. Всё остальное отсекается (`trimTraffic`):
// страница видео TikTok сама тянет десятки чужих фреймов, и это они дают полсотни renderer'ов.
// ⚠️ Список — куски имён хостов, а не точные имена: у TikTok их с десяток семейств.
const HOSTS_TIKTOK = ["tiktok", "tiktokcdn", "tiktokv", "ttwstatic", "byteoversea", "bytedance", "byteimg", "ibytedtos", "musical.ly"];
const HOSTS_INSTAGRAM = ["instagram.com", "cdninstagram", "fbcdn.net", "facebook.com"];

// Две полосы обхода. `tt` — TikTok (и всё, чью площадку мы не знаем: пусть падает со своей
// ошибкой там, где падало и раньше), `ig` — Instagram.
const LANES = {
  tt: { tag: "[tt]", profile: PROFILE_TIKTOK, headless: false, hosts: HOSTS_TIKTOK, name: "TikTok" },
  ig: { tag: "[ig]", profile: PROFILE_OPERA, headless: true, hosts: HOSTS_INSTAGRAM, name: "Instagram" },
};

// Очередь в процессе: следующий обход ждёт, пока закончится текущий.
let chain = Promise.resolve();
let pending = 0;

const short = (e) => String(e?.message ?? e).split("\n")[0];

/** В какую полосу идёт креатор. Чистая функция: её проверяют тесты. */
export function laneOf(creator) {
  return (creator?.platform ?? "tiktok") === "instagram" ? "ig" : "tt";
}

/**
 * Креаторы по полосам, порядок внутри полосы сохраняется (сортировка приходит из базы).
 * Чистая функция: её проверяют тесты.
 */
export function splitLanes(creators) {
  const lanes = { tt: [], ig: [] };
  for (const creator of creators ?? []) lanes[laneOf(creator)].push(creator);
  return lanes;
}

/**
 * Нужна ли пауза после этого креатора.
 * Пауза только между креаторами TikTok — то есть между запусками ЧИСТЫХ профилей: она там и
 * заводилась. После креатора Instagram (постоянный профиль, браузер общий) ждать нечего, а
 * после «профиль не найден» тем более: страницы не было вовсе, очередь к TikTok не выстроена.
 * Чистая функция: её проверяют тесты.
 */
export function pauseAfter(lane, error = null) {
  if (lane !== "tt") return false;
  return !(error && /профиль не найден/i.test(String(error)));
}

/** Кто собирает этого креатора. Instagram — по IG_SOURCE (graph | web). */
function pickCollector(creator, env, depth, ctx) {
  const platform = creator.platform ?? "tiktok";
  if (platform === "tiktok") {
    return (log) => collectTikTok(creator, { browserChoice: env.browser, retryPauseMs: env.pauseMs, depth, log });
  }
  if (platform === "instagram") {
    if (env.igSource === "graph") {
      return (log) => collectInstagramGraph(creator, { token: env.igToken, userId: env.igUserId, depth, log });
    }
    // Браузер полосы уже поднят и уже с перехватом: свой модуль не заводит.
    return (log) => collectInstagramWeb(creator, { browserChoice: env.browser, depth, ctx, log });
  }
  throw new Error(`неизвестная площадка: ${platform}`);
}

/**
 * Браузер полосы: поднимается ЛЕНИВО (первым, кому он понадобился) и живёт до конца полосы.
 * Не поднялся — второй раз не пробуем: беда запомнена, и остальные креаторы полосы её просто
 * получают. Профиль не стирается никогда.
 */
function laneBrowser(kind, env) {
  const cfg = LANES[kind];
  let started = null, broken = null;
  return {
    tag: cfg.tag,
    profile: basename(cfg.profile),
    /** Открытый контекст. Бросает Error с русским текстом, если браузер не встал. */
    async ctx(log) {
      if (started) return started.ctx;
      if (broken) throw new Error(broken);
      try {
        if (kind === "tt") {
          // Вторая копия профиля под эту полосу: одна папка — один процесс браузера.
          const { copied, from, to } = ensureProfileCopy(cfg.profile, PROFILE_OPERA);
          if (copied) log(`  заведена вторая копия профиля: ${to} (из ${from}, без кэшей и сессий вкладок)`);
        }
        const browser = await launchProfile(env.browser, { headless: cfg.headless, profile: cfg.profile, log });
        let traffic = null;
        // Перехват ставится РАЗ на контекст полосы: он живёт на контексте, а не на вкладке,
        // и второй `ctx.route` просто множил бы обработчики на каждого креатора.
        try {
          traffic = await trimTraffic(browser.ctx, cfg.hosts, { log });
        } catch (e) {
          log(`  лишнее отсечь не вышло: ${short(e)}`);
        }
        started = { ...browser, traffic };
        log(`  браузер полосы: ${browser.describe}, профиль ${basename(cfg.profile)}${cfg.headless ? "" : ", окно настоящее — скрытому TikTok комментарии не отдаёт"}`);
        return started.ctx;
      } catch (e) {
        broken = short(e);
        throw new Error(broken);
      }
    },
    /** Поднимался ли браузер вообще (пустой полосе он не нужен). */
    up() {
      return started !== null;
    },
    async close(log) {
      if (!started) return;
      const seen = started.traffic?.() ?? null;
      if (seen) log(`лишних запросов отсечено ${seen.aborted}, пропущено ${seen.passed}`);
      try {
        await started.cleanup();
      } catch (e) {
        // Браузер мог упасть сам — на итог обхода это не влияет, но сказать стоит.
        log(`браузер полосы не закрылся: ${short(e)}`);
      }
      started = null;
    },
  };
}

/**
 * Нынешние `cover_url` этих видео из базы: что уже наше — перекладывать второй раз незачем.
 * Батчами по 100 id в адресе, как и записи в `db.mjs`.
 * База не ответила — обход из-за картинок не роняем: считаем, что прежних адресов не знаем,
 * и просто перекладываем всё заново (следующий обход всё равно приведёт картинки в порядок).
 */
async function coversInDb(ids, log) {
  const out = new Map();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((id) => `"${encodeURIComponent(id)}"`).join(",");
      for (const row of await get(`videos?select=id,cover_url&id=in.(${list})`)) {
        out.set(String(row.id), row.cover_url ?? null);
      }
    }
  } catch (e) {
    const text = String(e?.message ?? e).split("\n")[0];
    log?.(`  прежние обложки не спросились: ${text}`);
    notice("db", `прежние обложки не спросились: ${text}`);
  }
  return out;
}

/**
 * Картинки Instagram — к себе в хранилище. Отдаёт `{ avatarUrl, covers }`:
 *   • `avatarUrl` — что писать в `creators.avatar_url`; `null` — прежний не трогать;
 *   • `covers` — Map «id видео → адрес обложки», уже готовая к записи.
 * Ни одна картинка обход не валит: не вышло — счётчик в итоговой строке и строка в лог.
 */
async function rehostInstagram(creator, profile, videos, log) {
  // Аватар перекладывается каждый обход: путь в бакете один и тот же, `x-upsert` кладёт
  // поверх — значит сменившаяся картинка профиля обновится на сайте сама.
  let avatarUrl = null;
  let avatarNote = "нет";
  if (creator.avatar_custom !== false) {
    avatarNote = "свой";  // владелец загрузил картинку — аватар площадки её не перебивает
  } else if (profile.avatar) {
    avatarUrl = await rehostImage(profile.avatar, avatarPath(creator.id), { log });
    avatarNote = avatarUrl ? "ок" : "не вышло";
  }

  const covers = new Map();
  let done = 0, failed = 0;
  if (videos.length > 0) {
    const known = await coversInDb(videos.map((v) => v.id), log);
    const todo = [];
    for (const v of videos) {
      const prev = known.get(String(v.id)) ?? null;
      if (isOurs(prev)) covers.set(v.id, prev);        // уже переложена — оставляем как есть
      else if (v.coverUrl) todo.push(v);
      else covers.set(v.id, null);
    }
    for (let i = 0; i < todo.length; i += COVERS_PARALLEL) {
      const pack = todo.slice(i, i + COVERS_PARALLEL);
      const got = await Promise.all(pack.map((v) => rehostImage(v.coverUrl, coverPath(creator.id, v.id), { log })));
      pack.forEach((v, k) => {
        if (got[k]) done++; else failed++;
        // Не вышло — пишем `null`: прежний адрес здесь заведомо не наш (наш ушёл бы веткой
        // выше), а чужой на сайте всё равно не покажется.
        covers.set(v.id, got[k]);
      });
      if (i + COVERS_PARALLEL < todo.length) await sleep(COVERS_PAUSE_MS);
    }
  }
  log?.(`  картинки: аватар ${avatarNote}, обложек переложено ${done}, не вышло ${failed}`);
  return { avatarUrl, covers };
}

/**
 * При каком числе комментариев тексты этих видео снимались в прошлый раз.
 * База не ответила — шаг из-за этого не встаёт: считаем, что не знаем ничего, и снимаем всё
 * (лишняя работа лучше потерянных комментариев).
 */
async function syncedCounts(ids, log) {
  const out = new Map();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((id) => `"${encodeURIComponent(id)}"`).join(",");
      for (const row of await get(`videos?select=id,comments_synced_count,ours&id=in.(${list})`)) {
        out.set(String(row.id), { count: row.comments_synced_count ?? null, ours: row.ours !== false });
      }
    }
  } catch (e) {
    log?.(`  прежние числа комментариев не спросились: ${short(e)}`);
    notice("db", `прежние числа комментариев не спросились: ${short(e)}`);
  }
  return out;
}

/**
 * Кого из видео обходить за текстами комментариев.
 *   • только свежие (`sinceMs`) и только те, у которых комментарии есть вовсе;
 *   • только НАШИ (`videos.ours`; владелец, 2026-09-08: счётчики из списка — по всем видео,
 *     «всю остальную информацию» — по нашим). Флаг `allVideos` (просьба «и не наши видео» из
 *     матрицы) снимает это условие. Видео, о котором база не сказала (нет строки), — считается
 *     нашим: лишняя работа лучше потерянных комментариев;
 *   • видео, у которого число комментариев ровно то же, что при прошлом съёме
 *     (`videos.comments_synced_count`), пропускается: обсуждение не двигалось, а страница
 *     на видео стоит минуты. Первый раз (`null` или неизвестно) — снимаем всегда.
 * `known` — Map id → `{ count, ours }` (старый вид «id → число» тоже понимается).
 * Отдаёт `{ picked, unchanged, foreign }`. Чистая функция: её проверяют тесты.
 */
export function pickComments(videos, known, sinceMs, { allVideos = false } = {}) {
  const picked = [], unchanged = [], foreign = [];
  for (const v of videos ?? []) {
    const count = v.comments ?? 0;
    if (count <= 0) continue;
    if (v.publishedAt === null || v.publishedAt === undefined) continue;
    if (Date.parse(v.publishedAt) < sinceMs) continue;
    const row = known?.get(String(v.id));
    const was = row !== null && typeof row === "object" ? row.count : row;
    const ours = row !== null && typeof row === "object" ? row.ours !== false : true;
    if (!ours && !allVideos) {
      foreign.push(v);
      continue;
    }
    if (was !== null && was !== undefined && Number(was) === Number(count)) unchanged.push(v);
    else picked.push(v);
  }
  return { picked, unchanged, foreign };
}

/**
 * Тексты комментариев к свежим видео креатора — браузером полосы, под сессией фейкового
 * аккаунта. Число комментариев к этому моменту уже лежит в `video_snaps.comments`; здесь
 * собираются сами тексты.
 *
 * Правила шага:
 *   • кого берём — решает `pickComments` (свежесть, наличие комментариев, «число не менялось»);
 *   • браузер ОДИН НА ПОЛОСУ и поднят снаружи: профиль постоянный, и второй процесс на этой
 *     папке не встанет. TikTok водится с настоящим окном (в скрытом он отдаёт пустые тела и
 *     капчу), Instagram обходится скрытым — это разница между полосами, а не между креаторами;
 *   • ошибка одного видео шаг не валит, обход не роняет и `creators.sync_error` не ставит:
 *     комментарии — добавка к снимкам, а не их условие;
 *   • вместе с корневыми снимаются и ответы под ними (`parent_id` = id корневого, не больше
 *     `AMESTAT_REPLIES_MAX` на ветку) — они ложатся в ту же таблицу тем же upsert'ом.
 *     `replies: false` отменяет только клики по веткам; даровые ответы приезжают всё равно.
 */
async function collectComments(creator, videos, env, lane, flags, log) {
  const platform = creator.platform ?? "tiktok";
  const collect = platform === "tiktok" ? collectTikTokComments
    : platform === "instagram" ? collectInstagramComments
      : null;
  if (!collect) return;

  const since = Date.now() - env.commentsDays * DAY_MS;
  const known = await syncedCounts(videos.map((v) => v.id), log);
  const { picked, unchanged, foreign } = pickComments(videos, known, since, { allVideos: flags.allVideos });
  const same = unchanged.length > 0 ? `, без изменений: ${unchanged.length} видео` : "";
  const alien = foreign.length > 0 ? `, не наших: ${foreign.length} видео` : "";
  if (picked.length === 0) {
    log?.(`  комментарии: видео 0, собрано 0, не вышло 0 (свежих с новыми комментариями нет за ${env.commentsDays} дн.${same}${alien})`);
    return;
  }
  if (unchanged.length > 0) log?.(`  комментарии: без изменений: ${unchanged.length} видео — их не открываем`);
  if (foreign.length > 0) log?.(`  комментарии: не наших: ${foreign.length} видео — тексты у них не снимаем (нужны — просьба «и не наши видео»)`);
  if (flags.allVideos) log?.(`  комментарии: просьба «и не наши видео» — снимаем у всех свежих`);

  let ctx = null;
  try {
    ctx = await lane.ctx(log);
  } catch (e) {
    // Нет профиля или не поднялся браузер — снимки уже записаны, обход этим не портим.
    log?.(`  комментарии: ${short(e)}`);
    notice("comments", `@${creator.handle}: браузер для комментариев не поднялся — ${short(e)}`);
    return;
  }

  let rows = 0, answers = 0, failed = 0;
  for (let i = 0; i < picked.length; i++) {
    const video = picked[i];
    try {
      const list = await collect(
        ctx,
        { id: video.id, url: video.url, creatorHandle: creator.handle },
        { max: env.commentsMax, repliesMax: env.repliesMax, expandReplies: flags.replies, profile: lane.profile, log },
      );
      const now = new Date().toISOString();
      if (list.length > 0) {
        // `first_seen_at` не шлём вовсе: его база ставит один раз, при первой встрече.
        await upsert("video_comments", list.map((c) => ({
          id: c.id,
          video_id: video.id,
          parent_id: c.parentId,
          author_handle: c.authorHandle,
          author_name: c.authorName,
          text: c.text,
          likes: c.likes,
          replies: c.replies,
          created_at: c.createdAt,
          last_seen_at: now,
        })), "video_id,id");
      }
      // Число из СНИМКА, а не из числа собранных строк: сравнивать в следующий раз мы будем
      // именно со счётчиком площадки, и потолок `AMESTAT_COMMENTS_MAX` тут ни при чём.
      await patch(`videos?id=eq.${encodeURIComponent(video.id)}`, {
        comments_synced_at: now,
        comments_synced_count: video.comments ?? null,
      });
      rows += list.length;
      answers += list.filter((c) => c.parentId).length;
    } catch (e) {
      failed++;
      log?.(`    видео ${video.id}: ${short(e)}`);
      notice("comments", `@${creator.handle} видео ${video.id}: ${short(e)}`);
    }
    if (i < picked.length - 1) await sleep(COMMENTS_PAUSE_MS);
  }
  log?.(`  комментарии: видео ${picked.length}, собрано ${rows} (ответов ${answers}${flags.replies ? "" : ", ветки не раскрывались"}), не вышло ${failed}${same}`);
}

async function collectOne(creator, env, depth, lane, flags, log) {
  // Instagram собирается браузером полосы — тем же, который потом пойдёт за комментариями.
  // TikTok свой список видео берёт чистым одноразовым профилем и браузера полосы не трогает.
  const instagramWeb = (creator.platform ?? "tiktok") === "instagram" && env.igSource !== "graph";
  const ctx = instagramWeb ? await lane.ctx(log) : null;
  const collect = pickCollector(creator, env, depth, ctx);
  const { profile, videos } = await collect(log);
  const takenAt = new Date().toISOString();
  const instagram = (creator.platform ?? "tiktok") === "instagram";

  await insertMany("creator_snaps", [{
    creator_id: creator.id,
    taken_at: takenAt,
    followers: profile.followers ?? null,
    following: profile.following ?? null,
    likes_total: profile.likesTotal ?? null,
    videos_count: profile.videosCount ?? null,
  }]);

  // Картинки Instagram — в свой бакет; у TikTok адреса площадки идут в базу как есть.
  const images = instagram ? await rehostInstagram(creator, profile, videos, log) : null;

  if (videos.length > 0) {
    await upsert("videos", videos.map((v) => ({
      id: v.id,
      creator_id: creator.id,
      published_at: v.publishedAt,
      caption: v.caption ?? "",
      cover_url: images ? images.covers.get(v.id) ?? null : v.coverUrl ?? null,
      url: v.url,
      duration_s: v.durationS ?? null,
      last_seen_at: takenAt,
    })), "id");

    await insertMany("video_snaps", videos.map((v) => ({
      video_id: v.id,
      taken_at: takenAt,
      views: v.views ?? null,
      likes: v.likes ?? null,
      comments: v.comments ?? null,
      shares: v.shares ?? null,
      saves: v.saves ?? null,
    })));

    // Тексты комментариев — после снимков и только по свежим видео: строки `video_comments`
    // ссылаются на `videos`, значит upsert выше должен пройти первым.
    // ⚠️ `comments: false` пропускает шаг целиком — вместе с запросом прежних чисел.
    if (flags.comments) await collectComments(creator, videos, env, lane, flags, log);
    else log?.("  комментарии: пропущены (просьба без комментариев)");
  }

  // Своя картинка владельца сильнее аватара площадки.
  // У Instagram в базу идёт только наш переложенный адрес: чужой подписанный браузер на сайте
  // не покажет. Не переложилось — прежний `avatar_url` не трогаем вовсе.
  const avatar = instagram
    ? (images.avatarUrl ? { avatar_url: images.avatarUrl } : {})
    : (profile.avatar && creator.avatar_custom === false ? { avatar_url: profile.avatar } : {});

  // Имя и описание креатора — владельца (устав: сборщик пишет в creators только аватар,
  // last_synced_at и sync_error). Ник и подпись площадки в базу не идут.
  await patch(`creators?id=eq.${creator.id}`, {
    last_synced_at: takenAt,
    sync_error: null,
    ...avatar,
  });

  return { videos: videos.length, followers: profile.followers };
}

async function doSync({ trigger, creatorId, failedOnly, depth, comments, replies, allVideos, requestedBy, requestIds, slotLabel, onLog }) {
  const env = loadEnv();
  const lines = [];
  const log = (text) => {
    lines.push(text);
    onLog?.(text);
  };
  const failures = [];
  // Замечания копятся с этой минуты и уезжают владельцу одним сообщением в самом конце —
  // хоть по расписанию, хоть по кнопке с сайта (владелец, 2026-09-08).
  startRun();

  let runId = null;
  try {
    const run = await insertReturning("sync_runs", {
      trigger,
      scope: failedOnly ? "failed" : creatorId ?? "all",
      depth,
      comments,
      replies,
      all_videos: allVideos,
      requested_by: requestedBy ?? null,
    });
    runId = run?.id ?? null;
  } catch (e) {
    // База недоступна с первого шага — обхода не будет, но исключением никого не роняем:
    // и CLI, и резидент должны увидеть внятную строку, а не стек.
    const text = String(e?.message ?? e).split("\n")[0];
    log(`обход не начался: ${text}`);
    notice("run", `обход не начался: ${text}`);
    // Строки в базе нет, но сказать владельцу надо тем более: сайт тоже читает из базы.
    await reportRun({ runId: null, trigger, depth, done: 0, failed: 0, slotLabel, log });
    return { runId: null, ok: false, done: 0, failed: 0, error: text, failures, depth, log: lines.join("\n") };
  }
  const who = failedOnly ? "только неудавшиеся" : creatorId ? `креатор ${creatorId}` : "все";
  log(`обход #${runId} (${trigger}, ${who}, глубина ${depth === "week" ? "неделя" : "всё"}, комментарии ${comments ? "да" : "нет"}, ветки ${replies ? "да" : "нет"}${allVideos ? ", и не наши видео" : ""})`);

  // Просьбы забраны этим обходом — сайт перестаёт показывать «в очереди».
  if (requestIds?.length && runId) {
    try {
      await patch(`sync_requests?id=in.(${requestIds.join(",")})`, { taken_at: new Date().toISOString(), run_id: runId });
    } catch (e) {
      // Не пометилась просьба — обход всё равно идёт; кнопка на сайте просто задержится.
      const text = String(e?.message ?? e).split("\n")[0];
      log(`просьбы не помечены: ${text}`);
      notice("db", `просьбы не помечены взятыми: ${text}`);
    }
  }

  let done = 0, failed = 0, firstError = null;
  const flags = { comments, replies, allVideos };
  try {
    const where = `${creatorId ? `&id=eq.${creatorId}` : ""}${failedOnly ? "&sync_error=not.is.null" : ""}`;
    const creators = await get(`creators?select=${CREATOR_FIELDS}${where}&order=sort_order.asc,added_at.asc`);
    if (creators.length === 0) {
      log(failedOnly ? "ни у кого нет ошибки — повторять нечего" : creatorId ? "креатор не найден в базе" : "в базе нет ни одного креатора");
    }

    /**
     * Ход обхода для сайта (миграция v14; владелец, 2026-09-09: «что за обход, сколько
     * выполнено, на сколько ещё»). После каждого креатора в `sync_runs` уезжают счётчики и
     * те, кого собираем сейчас — по одному на полосу. Не уехало — обход не страдает: это
     * подсказка на кнопке, а не результат.
     */
    const current = new Map();
    let progressFailed = 0;
    async function progress() {
      if (!runId) return;
      try {
        await patch(`sync_runs?id=eq.${runId}`, {
          creators_total: creators.length,
          creators_done: done,
          creators_failed: failed,
          current_handles: [...current.values()].map((h) => `@${h}`),
          progress_at: new Date().toISOString(),
        });
      } catch (e) {
        // Одна строка в лог на первый сбой, дальше молчим: база и так уже под вопросом.
        if (progressFailed++ === 0) log(`ход обхода не записался: ${short(e)}`);
      }
    }
    await progress();

    /**
     * Одна полоса: её креаторы по очереди, свой браузер, свои паузы, свой префикс в логе.
     * Полосы идут одновременно, поэтому счётчики и `lines` общие — но JS однопоточен, и
     * между `await` их никто не перебивает.
     */
    async function runLane(kind, list) {
      if (list.length === 0) return { kind, spent: 0, done: 0 };
      const cfg = LANES[kind];
      const lane = laneBrowser(kind, env);
      const say = (text) => log(`${cfg.tag} ${text}`);
      const startedLane = Date.now();
      let laneDone = 0;
      say(`полоса ${cfg.name}: креаторов ${list.length}`);
      try {
        for (let i = 0; i < list.length; i++) {
          const creator = list[i];
          say(`@${creator.handle} (${creator.platform})`);
          current.set(kind, creator.handle);
          await progress();
          const started = Date.now();
          let error = null;
          try {
            const res = await collectOne(creator, env, depth, lane, flags, say);
            done++;
            laneDone++;
            say(`  готово: видео ${res.videos}, подписчиков ${res.followers ?? "?"}`);
          } catch (e) {
            failed++;
            error = short(e);
            failures.push({ handle: creator.handle, error });
            firstError = firstError ?? `@${creator.handle}: ${error}`;
            say(`  ошибка: ${error}`);
            notice("creator", `@${creator.handle}: ${error}`);
            try {
              await patch(`creators?id=eq.${creator.id}`, { sync_error: error });
            } catch (e2) {
              say(`  не записалась и ошибка креатора: ${short(e2)}`);
              notice("db", `@${creator.handle}: не записалась и ошибка креатора — ${short(e2)}`);
            }
          }
          current.delete(kind);
          await progress();
          const spent = Date.now() - started;
          if (spent > SLOW_CREATOR_MS) notice("slow", `@${creator.handle}: собирался ${Math.round(spent / 60_000)} мин`);
          // Пауза только между чистыми профилями TikTok — см. `pauseAfter`.
          if (i < list.length - 1 && env.pauseMs > 0 && pauseAfter(kind, error)) {
            say(`  пауза ${Math.round(env.pauseMs / 1000)} с`);
            await sleep(env.pauseMs);
          }
        }
      } finally {
        // Браузер полосы закрывается здесь и всегда: профиль постоянный, и оставленное окно
        // не даст подняться следующему обходу.
        await lane.close(say);
      }
      const spent = Date.now() - startedLane;
      say(`полоса ${cfg.name} закончена: собрано ${laneDone} из ${list.length} за ${Math.round(spent / 1000)} с`);
      return { kind, spent, done: laneDone };
    }

    const lanes = splitLanes(creators);
    // Полосы идут разом: одна водит чистые профили TikTok, вторая — Instagram в своём
    // постоянном профиле. Общего у них только база, счётчики и лог.
    await Promise.all([runLane("tt", lanes.tt), runLane("ig", lanes.ig)]);
    // Мягкие признаки истёкшей сессии — одной строкой на площадку и только в лог.
    for (const hint of takeSessionHints()) {
      log(`[session] ${hint.where}: признаки истёкшей сессии в ${hint.count} местах, но собралось всё — ${hint.text}`);
    }
    return { runId, ok: failed === 0, done, failed, error: firstError, failures, depth, log: lines.join("\n") };
  } catch (e) {
    // Сюда попадает только беда всего обхода (например, база недоступна).
    const text = String(e?.message ?? e).split("\n")[0];
    log(`обход прерван: ${text}`);
    notice("run", `обход прерван: ${text}`);
    firstError = firstError ?? text;
    return { runId, ok: false, done, failed, error: firstError, failures, depth, log: lines.join("\n") };
  } finally {
    // Сначала сообщение владельцу, потом запись итога: текст замечаний уходит в `lines` и должен
    // попасть в `sync_runs.log` — иначе на сайте не видно, о чём владельцу сказали.
    // `slotLabel` — только у неудавшегося повтора: одно письмо на обход, отдельного «не удался
    // дважды» больше нет (владелец, 2026-09-08: два письма об одном событии).
    await reportRun({ runId, trigger, depth, done, failed, slotLabel: failed > 0 || firstError ? slotLabel ?? null : null, log });
    if (runId) {
      try {
        await patch(`sync_runs?id=eq.${runId}`, {
          finished_at: new Date().toISOString(),
          ok: failed === 0 && firstError === null,
          error: firstError,
          creators_done: done,
          creators_failed: failed,
          log: lines.join("\n"),
        });
      } catch (e) {
        const text = String(e?.message ?? e).split("\n")[0];
        onLog?.(`итог обхода не записался: ${text}`);
        // Сообщение обхода уже ушло — это замечание уедет резидентским, своим чередом.
        notice("db", `итог обхода #${runId} не записался: ${text}`);
      }
    }
  }
}

/**
 * Один обход. Пока идёт предыдущий — ждёт его в очереди.
 * `{ trigger: 'schedule'|'catchup'|'manual'|'retry', creatorId?, failedOnly?, depth?,
 *    comments?, replies?, allVideos?, requestedBy?, requestIds?, slotLabel?, onLog? }`
 * `comments` — снимать ли тексты комментариев (`false` — шага нет вовсе);
 * `allVideos` — снимать ли тексты и у НЕ наших видео (по умолчанию `false`: только наши,
 * `videos.ours`; расписание, догон и повтор его не ставят никогда);
 * `replies` — раскрывать ли ветки ответов (`false` — корневые снимаются, ветки не раскрываются,
 * но даровые ответы внутри корневых всё равно кладутся: они не стоят ни клика, ни запроса).
 * Оба по умолчанию `true` — как расписание, догон и повтор.
 * `slotLabel` — час неудавшегося слота у повтора: если и повтор не удался, письмо обхода
 * получает строку «вторая неудача подряд после слота HH:MM» и второго письма не бывает.
 * Отдаёт `{ runId, ok, done, failed, error, failures, depth, log }` — исключений не бросает.
 * `failures` — `[{ handle, error }]` по каждому неудавшемуся креатору: из них резидент
 * собирает сообщение владельцу в Telegram.
 */
export function runSync({ trigger = "manual", creatorId = null, failedOnly = false, depth = "all", comments = true, replies = true, allVideos = false, requestedBy = null, requestIds = [], slotLabel = null, onLog } = {}) {
  const args = {
    trigger, creatorId, failedOnly,
    depth: depth === "week" ? "week" : "all",
    comments: comments !== false,
    replies: replies !== false,
    allVideos: allVideos === true,
    requestedBy, requestIds, slotLabel, onLog,
  };
  pending++;
  const next = chain.then(
    () => doSync(args),
    () => doSync(args),
  );
  chain = next.then(() => {}, () => {});
  return next.finally(() => { pending--; });
}

/** Идёт ли сейчас обход (или уже ждёт в очереди) — резиденту, чтобы копить просьбы, а не плодить обходы. */
export function busy() {
  return pending > 0;
}

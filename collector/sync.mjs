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
//   • Глубина (`depth`, миграция v18): 'all' — весь список видео, 'week' — 7 дней, 'month' —
//     30, 'range' — период между `depthFrom` и `depthTo`. Границы считаются ОДИН раз на обход
//     (`depthBounds` в `scope.mjs`) и уходят площадкам готовыми: дат они не считают.
//     Снимок профиля делается всегда одинаково, при любой глубине.
//   • Охват видео (`videos`, миграция v17; владелец, 2026-09-09): 'all' — как было всегда,
//     'ours' — «на лишние видео не смотрим и экономим время». При 'ours' сборщик СНАЧАЛА
//     спрашивает у базы отслеживаемые видео креатора (`ours` или `watch`) и листает список
//     ровно до тех пор, пока все они не встретятся (правила — `scope.mjs`). Расписание, догон
//     и повтор ходят с 'all' всегда. ⚠️ Тексты комментариев охват не меняет: они и так только
//     у наших, жёлтые получают одни счётчики.
//   • Потолок числа видео (`maxVideos`, миграция v19): не больше стольких самых новых видео на
//     креатора в пределах глубины — прокрутка обрывается, лишнее в базу не идёт. Пусто (null) —
//     потолка нет; расписание, догон и повтор после слота ходят без него всегда. Правила —
//     `scope.mjs`; отслеживаемые видео потолок не режет.
//   • Повтор после неудачи (`failedOnly`) берёт только тех, у кого в `creators.sync_error`
//     что-то есть: успевшие собраться второй раз за час не тревожатся.
//   • Тексты комментариев — отдельный шаг ПОСЛЕ снимков видео и только по свежим роликам
//     (`AMESTAT_COMMENTS_DAYS`, у которых комментарии вообще есть). Он ходит браузером полосы,
//     под сессией фейкового аккаунта, и ошибка на видео обход не валит: снимки уже записаны.
//     Два выключателя приходят из просьбы: `comments = false` — шага нет вовсе, `replies = false`
//     — корневые снимаются, а ветки не раскрываются (даровые ответы всё равно кладутся: они
//     приезжают внутри корневого и не стоят ни клика, ни запроса).
//   • Симбиоз прямого запроса и браузера (владелец, 2026-09-10: «где можно — прямой запрос, где
//     он не отработал — наш браузерный код; максимально делегировать прямым, они банально
//     быстрее»). На шаге комментариев TikTok КАЖДОЕ видео сначала пробуется прямым запросом
//     (`direct.mjs`, без браузера и без подписи); не дал — то же видео идёт браузером, как и
//     раньше, и весь прежний код остаётся рабочим. Отсюда два следствия:
//       — браузер полосы TikTok поднимается ЛЕНИВО: все видео сняты прямым — окно не открывается
//         вовсе, и в логе видно «браузер не понадобился»;
//       — ⚠️ СПИСОК ВИДЕО прямым не берётся никогда: `api/post/item_list` без подписи отдаёт
//         пустое тело. Снимок профиля — берётся (HTML страницы), браузер там откат.
//     Выключатель `AMESTAT_DIRECT=off` возвращает всё на браузер целиком.
//   • Видео, у которого число комментариев не изменилось с прошлого съёма
//     (`videos.comments_synced_count`), второй раз не обходится вовсе: минуты уходили на то же
//     самое. Первый раз (там `null`) — снимаем всегда.
//   • Картинки Instagram на чужих адресах не остаются: аватар и обложки перекладываются в
//     свой бакет (`images.mjs`), в базу идёт наш публичный адрес. Причина — в `images.mjs`;
//     у TikTok картинки показываются как есть, и его это не касается вовсе.
//   • Запусков чистого профиля TikTok — не больше `AMESTAT_TT_LAUNCHES` за `AMESTAT_TT_WINDOW_MIN`
//     минут НА КАЖДЫЙ АДРЕС (`tiktok-gate.mjs`). Свободного адреса нет — полоса TikTok ЖДЁТ, пишет
//     об этом в журнал и кладёт в `sync_runs.current_handles` строку «пауза TikTok до HH:MM».
//     Полосу Instagram ожидание не задевает: полосы идут через `Promise.all`.
//   • Адреса (`proxies.mjs`, 2026-09-09): пул из домашнего адреса и прокси `AMESTAT_PROXIES`
//     чередуется по кругу, и «защита TikTok по адресу» перестаёт быть потолком скорости. Адрес
//     выбирает сам шаг списка через `pool` — так вторая попытка после пустого списка уходит на
//     СЛЕДУЮЩИЙ адрес, а не на тот же. ⚠️ Браузеры полос (Instagram, комментарии) сидят на
//     домашнем адресе, пока `AMESTAT_PROXY_SCOPE` не `all`: в них живут ВОШЕДШИЕ аккаунты, а
//     смена адреса у вошедшего аккаунта ловит проверки безопасности.
//   • Каждая строка лога уезжает в `sync_log` ПО ХОДУ дела (`synclog.mjs`, миграция v16) —
//     сайт показывает администратору живой журнал. `sync_runs.log` (весь текст в конце) остался.
//   • Объём работы оценивается ОДИН раз, до первого браузера (`estimate.mjs`, миграция v24;
//     владелец, 2026-09-09: «„6 из 10 креаторов“ ничего не говорит: может, прошли шесть самых
//     быстрых»). Единица — секунда по калибровке; `work_total` уходит в строку обхода, а
//     `work_done` растёт ПОСЛЕ КАЖДОГО ШАГА (список собран, видео комментариев снято), а не
//     после каждого креатора. ⚠️ Прогноз конца считается ПО ПОЛОСАМ: они идут одновременно, и
//     обход кончается, когда закончит самая долгая. Колонок в базе нет (миграция не накачена) —
//     обход идёт как прежде, просто без полосы прогресса.

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
import { takeLaunchSlot } from "./tiktok-gate.mjs";
import { labelOf, rememberBad, rememberGood } from "./proxies.mjs";
import { startSyncLog, pushSyncLog, stopSyncLog } from "./synclog.mjs";
import { depthBounds, depthLabel, normalizeDepth, videoCap } from "./scope.mjs";
import {
  calibrateComments,
  calibrateList,
  commentKeys,
  commentsWindow,
  estimateRun,
  etaSeconds,
  readTiming,
  writeTiming,
} from "./estimate.mjs";
import { fetchComments, fetchReplies } from "./direct.mjs";
import { pickReplies } from "./replies.mjs";
import { basename } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CREATOR_FIELDS = "id,platform,handle,display_name,avatar_custom,sort_order,added_at";
const COVERS_PARALLEL = 4;      // столько обложек качаем разом
const COVERS_PAUSE_MS = 100;    // и пауза между пачками: чужой CDN не любит очередь запросов подряд
const COMMENTS_PAUSE_MS = 3000; // пауза между видео на шаге комментариев
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
const hhmm = (date) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
};

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

/**
 * Адрес для браузера полосы. Пусто — домашний, как было всегда.
 *
 * ⚠️ При `AMESTAT_PROXY_SCOPE=all` берётся ОДИН И ТОТ ЖЕ адрес — первый прокси пула, — а не
 * следующий по кругу: в профилях полос живут вошедшие фейковые аккаунты, и гуляющий адрес у
 * вошедшего аккаунта — это проверки безопасности площадки, а не выигрыш в скорости. Чередование
 * заведено ради ЧИСТЫХ профилей списка TikTok, где входа нет вовсе.
 */
function laneProxy(env) {
  if (env.proxyScope !== "all") return null;
  return (env.proxyAddresses ?? []).find((a) => a.id > 0) ?? null;
}

/**
 * Кто собирает этого креатора. Instagram — по IG_SOURCE (graph | web).
 * `depth` и `bounds` идут вместе: первое — на слово в логе, второе — готовые границы отбора
 * (`depthBounds`, посчитаны один раз на обход).
 * `scope` — охват списка: `{ videos: 'all'|'ours', trackedIds, maxPages }`. Graph API листает
 * по-своему (там страницы дешёвые и правило прокрутки не при чём) — ему охват не передаётся.
 * `pool` — адреса для чистых профилей списка TikTok (см. `laneBrowser` и `takeLaunchSlot`).
 */
function pickCollector(creator, env, depth, bounds, ctx, scope, pool) {
  const platform = creator.platform ?? "tiktok";
  if (platform === "tiktok") {
    return (log) => collectTikTok(creator, { browserChoice: env.browser, depth, bounds, scope, pool, direct: env.direct, log });
  }
  if (platform === "instagram") {
    if (env.igSource === "graph") {
      return (log) => collectInstagramGraph(creator, { token: env.igToken, userId: env.igUserId, depth, bounds, log });
    }
    // Браузер полосы уже поднят и уже с перехватом: свой модуль не заводит.
    return (log) => collectInstagramWeb(creator, { browserChoice: env.browser, depth, bounds, ctx, scope, proxy: laneProxy(env), log });
  }
  throw new Error(`неизвестная площадка: ${platform}`);
}

/**
 * Отслеживаемые видео креатора: наши (`ours`) и жёлтые (`watch`). Нужны охвату 'ours' — по ним
 * список листается ровно до тех пор, пока все они не встретятся.
 * База не ответила — отдаём `null`: тогда охват для этого креатора опускается до 'all'. Лишняя
 * работа лучше необновлённых наших видео.
 */
async function trackedVideos(creatorId, log) {
  try {
    const rows = await get(`videos?select=id,published_at&creator_id=eq.${encodeURIComponent(creatorId)}&or=(ours.eq.true,watch.eq.true)`);
    return rows.map((r) => ({ id: String(r.id), publishedAt: r.published_at ?? null }));
  } catch (e) {
    log?.(`  отслеживаемые видео не спросились: ${short(e)}`);
    notice("db", `отслеживаемые видео не спросились: ${short(e)}`);
    return null;
  }
}

/**
 * Объём обхода в секундах — ДО первого браузера (миграция v24). Всё, что для этого нужно, уже
 * лежит в базе: сколько у креатора видео, какой они давности, какие из них наши и жёлтые и у
 * каких есть комментарии. Правила счёта — в `estimate.mjs`, здесь только запросы.
 *
 * Запроса два: список видео нужных креаторов и счётчики комментариев у тех из них, что попадают
 * в окно шага комментариев (у остальных счётчик на оценку не влияет вовсе).
 * ⚠️ Ошибку наверх не глушим: её ловит вызывающий и просто идёт без оценки.
 */
async function estimateWork(creators, env, depth, bounds, flags, timing) {
  const rows = [];
  // Пачками по 20 креаторов: адрес запроса не резиновый. `limit` — на случай, если у проекта
  // выставлен потолок строк: лучше недооценить, чем получить обрезанный ответ молча.
  for (let i = 0; i < creators.length; i += 20) {
    const list = creators.slice(i, i + 20).map((c) => `"${encodeURIComponent(c.id)}"`).join(",");
    const part = await get(`videos?select=creator_id,id,published_at,ours,watch&creator_id=in.(${list})&limit=20000`);
    rows.push(...part);
  }

  const counts = new Map();
  if (flags.comments) {
    const win = commentsWindow({ bounds });
    const hasSince = win.since !== null && win.since !== undefined;
    const hasUntil = win.until !== null && win.until !== undefined;
    const fresh = rows
      .filter((r) => {
        // Границ нет вовсе (глубина «всё») — счётчик нужен у каждого видео, и у безымянного по
        // дате тоже: шаг его возьмёт, значит и оценка должна о нём знать.
        if (!hasSince && !hasUntil) return true;
        const at = r.published_at ? Date.parse(r.published_at) : NaN;
        if (Number.isNaN(at)) return false;
        if (hasSince && at < win.since) return false;
        if (hasUntil && at > win.until) return false;
        return true;
      })
      .map((r) => String(r.id));
    for (let i = 0; i < fresh.length; i += 100) {
      const list = fresh.slice(i, i + 100).map((id) => `"${encodeURIComponent(id)}"`).join(",");
      for (const row of await get(`video_latest?select=video_id,comments&video_id=in.(${list})`)) {
        counts.set(String(row.video_id), row.comments ?? 0);
      }
    }
  }

  return estimateRun(creators, rows, counts, {
    depth,
    bounds,
    videos: flags.videos,
    maxVideos: flags.maxVideos,
    comments: flags.comments,
    replies: flags.replies,
    allVideos: flags.allVideos,
    // Прямой путь включён — шаг комментариев TikTok считается по дешёвым единицам (v24 +
    // `comments.direct`): иначе оценка обещала бы часы там, где обход укладывается в минуты.
    direct: env.direct === true,
  }, timing);
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
        const browser = await launchProfile(env.browser, { headless: cfg.headless, profile: cfg.profile, proxy: laneProxy(env), log });
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
 * При каком числе комментариев тексты этих видео снимались в прошлый раз — и что это за видео:
 * наше (`ours`), жёлтое (`watch`, миграция v17) или чужое.
 * База не ответила — шаг из-за этого не встаёт: считаем, что не знаем ничего, и снимаем всё
 * (лишняя работа лучше потерянных комментариев).
 */
async function syncedCounts(ids, log) {
  const out = new Map();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((id) => `"${encodeURIComponent(id)}"`).join(",");
      for (const row of await get(`videos?select=id,comments_synced_count,ours,watch&id=in.(${list})`)) {
        out.set(String(row.id), { count: row.comments_synced_count ?? null, ours: row.ours !== false, watch: row.watch === true });
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
 *   • только попавшие в окно (`sinceMs`/`untilMs` — границы ГЛУБИНЫ обхода) и только те, у
 *     которых комментарии есть вовсе;
 *   • только НАШИ (`videos.ours`; владелец, 2026-09-08: счётчики из списка — по всем видео,
 *     «всю остальную информацию» — по нашим). Флаг `allVideos` (просьба «и не наши видео» из
 *     матрицы) снимает это условие. Видео, о котором база не сказала (нет строки), — считается
 *     нашим: лишняя работа лучше потерянных комментариев;
 *   • ⚠️ ЖЁЛТЫЕ (`videos.watch`, миграция v17) текстов НЕ получают: «смотрим историю» — это
 *     счётчики (владелец, 2026-09-09). В счёт они идут отдельной строкой лога, чтобы было
 *     видно, чего именно мы не снимали;
 *   • видео, у которого число комментариев ровно то же, что при прошлом съёме
 *     (`videos.comments_synced_count`), пропускается: обсуждение не двигалось, а страница
 *     на видео стоит минуты. Первый раз (`null` или неизвестно) — снимаем всегда.
 * `known` — Map id → `{ count, ours, watch }` (старый вид «id → число» тоже понимается).
 * `sinceMs` / `untilMs` — границы окна, и они те же, что у глубины обхода (владелец,
 * 2026-09-09): «неделя» — 7 дней, «месяц» — 30, «период» — сам период, «всё» — границ нет
 * вовсе (`null`), и тогда берутся все видео списка, у которых есть комментарии, — даже те,
 * у которых площадка не сказала даты.
 * Отдаёт `{ picked, unchanged, foreign, watched }`: `watched` — жёлтые, `foreign` — совсем
 * чужие; текстов не получают ни те ни другие, но в логе они названы порознь.
 * Чистая функция: её проверяют тесты.
 */
export function pickComments(videos, known, sinceMs = null, { allVideos = false, untilMs = null } = {}) {
  const picked = [], unchanged = [], foreign = [], watched = [];
  const hasSince = sinceMs !== null && sinceMs !== undefined;
  const hasUntil = untilMs !== null && untilMs !== undefined;
  for (const v of videos ?? []) {
    const count = v.comments ?? 0;
    if (count <= 0) continue;
    if (hasSince || hasUntil) {
      if (v.publishedAt === null || v.publishedAt === undefined) continue;
      const at = Date.parse(v.publishedAt);
      if (Number.isNaN(at)) continue;
      if (hasSince && at < sinceMs) continue;
      if (hasUntil && at > untilMs) continue;
    }
    const row = known?.get(String(v.id));
    const known_ = row !== null && typeof row === "object";
    const was = known_ ? row.count : row;
    const ours = known_ ? row.ours !== false : true;
    const watch = known_ ? row.watch === true : false;
    if (!ours && !allVideos) {
      // Жёлтое видео — не наше: тексты у него не снимаются так же, как у чужого. Разница
      // только в строке лога: владелец должен видеть, что за историей мы всё-таки следим.
      (watch ? watched : foreign).push(v);
      continue;
    }
    if (was !== null && was !== undefined && Number(was) === Number(count)) unchanged.push(v);
    else picked.push(v);
  }
  return { picked, unchanged, foreign, watched };
}

/**
 * Комментарии одного видео TikTok ПРЯМЫМ запросом — без браузера (`direct.mjs`).
 * Отдаёт `{ ok, list, why, ms, branches }`; `ok: false` значит «прямой не дал» — и тогда то же
 * видео берёт браузерный путь, слово в слово прежний.
 *
 * Ветки: ответы, которые TikTok положил в корневой даром, уже приехали вместе с ним и не стоили
 * ничего; за остальными идёт отдельный запрос — по одному на ветку, и только если `replies > 0`
 * и даровых меньше потолка. `expandReplies: false` (просьба «без веток») отменяет ровно эти
 * запросы, как отменяла клики.
 * ⚠️ Ни одна упавшая ветка видео не роняет: беда считается, но строки корневых уже собраны.
 * На браузер видео уходит только если не отработала НИ ОДНА ветка — тогда прямому пути на этом
 * видео веры нет.
 */
async function directComments(video, creator, env, flags, log) {
  const started = Date.now();
  const handle = creator.handle;
  const head = await fetchComments(video.id, handle, {
    max: env.commentsMax,
    expected: video.comments ?? null,
    pauseMs: env.directPauseMs,
    log,
  });
  if (!head.ok) return { ok: false, list: [], why: head.why, ms: Date.now() - started, branches: 0 };

  const roots = head.comments;
  // Даровые ответы — те, что приехали внутри корневых: их считаем в первую очередь.
  const replies = new Map();
  for (const r of head.free ?? []) replies.set(r.id, r);
  const countOf = (parent) => [...replies.values()].filter((c) => c.parentId === parent).length;

  let asked = 0, gotBranches = 0, failedBranches = 0;
  if (flags.replies && env.repliesMax > 0) {
    for (const root of roots) {
      const want = Math.min(Number(root.replies ?? 0), env.repliesMax);
      if (want <= 0) continue;
      // Ветка уже целиком приехала даром — запрос за ней был бы платой ни за что.
      if (countOf(root.id) >= want) continue;
      asked++;
      const branch = await fetchReplies(video.id, root.id, handle, { max: env.repliesMax, pauseMs: env.directPauseMs });
      if (!branch.ok) { failedBranches++; continue; }
      gotBranches++;
      for (const r of branch.replies) if (!replies.has(r.id)) replies.set(r.id, r);
    }
    if (asked > 0 && gotBranches === 0) {
      return { ok: false, list: [], why: `ветки не отдались (${failedBranches} из ${asked})`, ms: Date.now() - started, branches: asked };
    }
    if (failedBranches > 0) log?.(`    прямой запрос: не отдались ${failedBranches} веток из ${asked} — остальное собрано`);
  }

  // Потолок ответов на ветку и отбор «только под собранными корневыми» — та же чистая функция,
  // что и у браузерного пути: правило одно, и второе его написание разошлось бы молча.
  const list = [...roots, ...pickReplies(replies.values(), roots, env.repliesMax)];
  return { ok: true, list, why: null, ms: Date.now() - started, branches: asked };
}

/**
 * Тексты комментариев к свежим видео креатора — прямым запросом, а где он не дал — браузером
 * полосы, под сессией фейкового аккаунта. Число комментариев к этому моменту уже лежит в
 * `video_snaps.comments`; здесь собираются сами тексты.
 *
 * Правила шага:
 *   • кого берём — решает `pickComments` (свежесть, наличие комментариев, «число не менялось»);
 *   • ⚠️ у TikTok каждое видео СНАЧАЛА пробуется прямым запросом (`directComments`), и только
 *     не давшее уходит браузеру. У Instagram прямого пути нет вовсе — там всё как было;
 *   • браузер ОДИН НА ПОЛОСУ и поднимается ЛЕНИВО — первым видео, которому он понадобился:
 *     профиль постоянный, и второй процесс на этой папке не встанет. Все видео сняты прямым —
 *     окно не открывается вовсе. TikTok водится с настоящим окном (в скрытом он отдаёт пустые
 *     тела и капчу), Instagram обходится скрытым — это разница между полосами, а не креаторами;
 *   • ошибка одного видео шаг не валит, обход не роняет и `creators.sync_error` не ставит:
 *     комментарии — добавка к снимкам, а не их условие;
 *   • вместе с корневыми снимаются и ответы под ними (`parent_id` = id корневого, не больше
 *     `AMESTAT_REPLIES_MAX` на ветку) — они ложатся в ту же таблицу тем же upsert'ом.
 *     `replies: false` отменяет только клики по веткам; даровые ответы приезжают всё равно.
 *
 * `work` — счётчик хода (`{ commentVideo() }`, миграция v24): зовётся после КАЖДОГО видео, а не
 * в конце шага. Шаг стоит десятки минут, и полоса прогресса, стоящая всё это время, врала бы.
 * Отдаёт `{ videos, ms, directVideos, directMs, browserVideos, browserMs }` — пути считаются
 * ПОРОЗНЬ: цены у них разные на порядок, и общее среднее калибровало бы обе в никуда
 * (`calibrateComments` с `direct`).
 */
async function collectComments(creator, videos, env, lane, flags, depth, bounds, log, work = null) {
  const started = Date.now();
  const nothing = () => ({ videos: 0, ms: Date.now() - started, directVideos: 0, directMs: 0, browserVideos: 0, browserMs: 0 });
  const platform = creator.platform ?? "tiktok";
  const collect = platform === "tiktok" ? collectTikTokComments
    : platform === "instagram" ? collectInstagramComments
      : null;
  if (!collect) return nothing();

  // 🔴 Окно шага — ровно глубина обхода (владелец, 2026-09-09): «неделя» — 7 дней, «месяц» —
  // 30, «период» — сам период, «всё» — без ограничения по дате вовсе. Своего окна у шага нет:
  // прежние «последние `AMESTAT_COMMENTS_DAYS` дней» при обходе за месяц давали счётчики
  // месячных видео и ни одного текста — «свежих с новыми комментариями нет за 7 дн.».
  const win = commentsWindow({ bounds });
  const since = win.since, until = win.until;
  const windowLabel = depthLabel(depth, since, until);
  const known = await syncedCounts(videos.map((v) => v.id), log);
  const { picked, unchanged, foreign, watched } = pickComments(videos, known, since, { allVideos: flags.allVideos, untilMs: until });
  const same = unchanged.length > 0 ? `, без изменений: ${unchanged.length} видео` : "";
  // Чужие и жёлтые считаются порознь: у обоих текстов нет, но жёлтое мы смотрим намеренно.
  const skipped = [
    foreign.length > 0 ? `не наших: ${foreign.length}` : null,
    watched.length > 0 ? `жёлтых: ${watched.length}` : null,
  ].filter(Boolean).join(", ");
  const alien = skipped ? `, ${skipped}` : "";
  log?.(`  комментарии: окно — ${windowLabel}`);
  if (picked.length === 0) {
    log?.(`  комментарии: видео 0, собрано 0, не вышло 0 (видео с новыми комментариями нет в окне «${windowLabel}»${same}${alien})`);
    return nothing();
  }
  if (unchanged.length > 0) log?.(`  комментарии: без изменений: ${unchanged.length} видео — их не открываем`);
  if (skipped) log?.(`  комментарии: ${skipped} — тексты не снимаем (нужны — просьба «и не наши видео»)`);
  if (flags.allVideos) log?.(`  комментарии: просьба «и не наши видео» — снимаем у всех видео окна`);

  // 🔴 Браузер полосы поднимается ЛЕНИВО — первым видео, которому он понадобился. Все видео
  // сняты прямым запросом — окно не открывается вовсе (владелец, 2026-09-10). Беда подъёма
  // запоминается: второй раз за один шаг не пробуем, как и в `laneBrowser`.
  let ctx = null, ctxBroken = null;
  const getCtx = async () => {
    if (ctx) return ctx;
    if (ctxBroken) throw new Error(ctxBroken);
    try {
      ctx = await lane.ctx(log);
      return ctx;
    } catch (e) {
      ctxBroken = short(e);
      notice("comments", `@${creator.handle}: браузер для комментариев не поднялся — ${ctxBroken}`);
      throw new Error(ctxBroken);
    }
  };

  // Прямой путь есть только у TikTok: у Instagram `direct.mjs` не при чём вовсе.
  const useDirect = env.direct && platform === "tiktok";
  if (!useDirect && platform === "tiktok") log?.("  комментарии: прямые запросы выключены (AMESTAT_DIRECT=off) — идём браузером");

  // Время меряется от ПЕРВОГО видео: подъём браузера полосы стоит своих секунд, и они уже
  // сосчитаны в шаге списка — второй раз в цену видео они попадать не должны.
  const startedVideos = Date.now();
  let rows = 0, answers = 0, failed = 0;
  let directVideos = 0, directMs = 0, browserVideos = 0, browserMs = 0, fellBack = 0;
  let firstWhy = null;
  for (let i = 0; i < picked.length; i++) {
    const video = picked[i];
    try {
      let list = null;
      // --- прямой запрос ----------------------------------------------------------------
      if (useDirect) {
        const one = await directComments(video, creator, env, flags, log);
        if (one.ok) {
          list = one.list;
          directVideos++;
          directMs += one.ms;
        } else {
          fellBack++;
          firstWhy = firstWhy ?? one.why;
          log?.(`    видео ${video.id}: прямой не дал (${one.why}) — иду браузером`);
        }
      }
      // --- откат: браузер, слово в слово прежний ------------------------------------------
      if (list === null) {
        const startedOne = Date.now();
        list = await collect(
          await getCtx(),
          { id: video.id, url: video.url, creatorHandle: creator.handle },
          { max: env.commentsMax, repliesMax: env.repliesMax, expandReplies: flags.replies, profile: lane.profile, log },
        );
        browserVideos++;
        browserMs += Date.now() - startedOne;
      }
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
    // Видео пройдено — двигаем полосу прогресса, чем бы оно ни кончилось: работа потрачена
    // и на упавшем.
    work?.commentVideo?.();
    // Пауза между видео заводилась под страницу в браузере. Видео, снятое прямым запросом,
    // страницы не открывало вовсе — ему хватает паузы прямого пути (`AMESTAT_DIRECT_PAUSE_MS`),
    // иначе три секунды на каждое сожрали бы весь выигрыш.
    if (i < picked.length - 1) await sleep(useDirect && browserVideos === 0 ? env.directPauseMs : COMMENTS_PAUSE_MS);
  }
  const secs = (ms) => Math.round(ms / 1000);
  if (useDirect) {
    log?.(`  комментарии: прямым запросом ${directVideos} видео (${secs(directMs)} с), браузером ${browserVideos}${fellBack > 0 ? ` (прямой не дал: ${firstWhy})` : ""}${browserVideos > 0 ? ` (${secs(browserMs)} с)` : ""}${browserVideos === 0 ? " — браузер не понадобился" : ""}`);
    if (fellBack > 0) notice("direct", `@${creator.handle}: прямой запрос не дал на ${fellBack} видео из ${picked.length} — ${firstWhy}`);
  }
  log?.(`  комментарии: видео ${picked.length}, собрано ${rows} (ответов ${answers}${flags.replies ? "" : ", ветки не раскрывались"}), не вышло ${failed}${same}`);
  return {
    videos: picked.length,
    ms: Date.now() - startedVideos,
    directVideos, directMs, browserVideos, browserMs,
  };
}

/**
 * Один креатор целиком: список, снимки, картинки, комментарии.
 * `work` — счётчик хода (миграция v24): `list()` зовётся, как только список собран, а
 * `commentVideo()` — после каждого видео шага комментариев.
 * Отдаёт, кроме итога, ЗАМЕРЫ для калибровки: сколько заняли шаги и на скольких единицах.
 * `pages` — число прокруток; площадка могла его не сказать (Graph API прокруток не делает
 * вовсе), и тогда шаг списка в калибровку не идёт.
 */
async function collectOne(creator, env, depth, bounds, lane, flags, log, pool = null, work = null) {
  // Instagram собирается браузером полосы — тем же, который потом пойдёт за комментариями.
  // TikTok свой список видео берёт чистым одноразовым профилем и браузера полосы не трогает.
  const instagramWeb = (creator.platform ?? "tiktok") === "instagram" && env.igSource !== "graph";
  const ctx = instagramWeb ? await lane.ctx(log) : null;

  // Охват «только наши»: список отслеживаемых видео спрашивается ДО браузера — по нему решается,
  // докуда листать. Не спросился — опускаемся до охвата «всё» на этого креатора.
  const scope = { videos: "all", trackedIds: [], maxPages: env.oursMaxPages, maxVideos: flags.maxVideos ?? null };
  if (flags.videos === "ours") {
    const tracked = await trackedVideos(creator.id, log);
    if (tracked === null) {
      log?.("  охват: только наши — список отслеживаемых не спросился, идём по всему списку");
    } else {
      scope.videos = "ours";
      scope.trackedIds = tracked.map((t) => t.id);
      const dates = tracked.map((t) => t.publishedAt).filter(Boolean).sort();
      const oldest = dates.length > 0 ? `, самое старое от ${String(dates[0]).slice(0, 10)}` : "";
      log?.(`  охват: только наши — отслеживаемых видео ${scope.trackedIds.length}${oldest}${scope.trackedIds.length === 0 ? " (берём только первую страницу списка)" : ""}`);
    }
  }

  const collect = pickCollector(creator, env, depth, bounds, ctx, scope, pool);
  const startedList = Date.now();
  const { profile, videos, pages } = await collect(log);
  const listMs = Date.now() - startedList;
  // Список собран — это первый и самый крупный шаг: полоса прогресса двигается здесь, а не
  // в конце креатора.
  work?.list?.();
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

  let commentsRun = { videos: 0, ms: 0, directVideos: 0, directMs: 0, browserVideos: 0, browserMs: 0 };
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
    if (flags.comments) commentsRun = await collectComments(creator, videos, env, lane, flags, depth, bounds, log, work);
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

  return {
    videos: videos.length,
    followers: profile.followers,
    listMs,
    pages: Number.isFinite(pages) ? pages : null,
    commentsMs: commentsRun.ms,
    commentVideos: commentsRun.videos,
    // Два пути шага комментариев порознь — калибровке (`comments.direct` против `comments.video`)
    // и строке времени в логе.
    directVideos: commentsRun.directVideos,
    directMs: commentsRun.directMs,
    browserVideos: commentsRun.browserVideos,
    browserMs: commentsRun.browserMs,
  };
}

async function doSync({ trigger, creatorId, failedOnly, depth, depthFrom, depthTo, videos, maxVideos, comments, replies, allVideos, requestedBy, requestIds, slotLabel, onLog }) {
  const env = loadEnv();
  const lines = [];
  // Границы отбора считаются РАЗ на обход и уходят площадкам готовыми: «сейчас» у полос иначе
  // разъехалось бы на минуты, а «месяц» пришлось бы заводить в трёх модулях (`scope.mjs`).
  const bounds = depthBounds(depth, { from: depthFrom, to: depthTo });
  const label = depthLabel(depth, depthFrom, depthTo);
  /**
   * Строка лога обхода. Уходит сразу в три места: в память (`sync_runs.log` в конце), тому, кто
   * обход завёл (консоль или файл резидента), и в живой журнал `sync_log` для сайта (v16).
   * `meta` — `{ source, handle, level }` для журнала; по умолчанию строка считается общей
   * (`system`), полосы передают `source: "browser"` и своего креатора.
   */
  const log = (text, meta = {}) => {
    lines.push(text);
    onLog?.(text);
    pushSyncLog(text, meta);
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
      // Края периода (v18). У остальных глубин колонки пусты — так стоит и в проверке базы.
      depth_from: depthFrom,
      depth_to: depthTo,
      // Охват видео этого обхода (v17): 'all' или 'ours'. Сайт читает его из строки обхода.
      videos,
      // Потолок числа видео (v19): число или null («без потолка»).
      max_videos: maxVideos,
      comments,
      replies,
      all_videos: allVideos,
      requested_by: requestedBy ?? null,
      // Каким путём шёл обход (v16). Провайдеры отложены — у нас всегда браузер.
      source: "browser",
    });
    runId = run?.id ?? null;
    // С этой минуты каждая строка лога уезжает в `sync_log` по ходу дела, а не в конце.
    startSyncLog(runId, (line) => onLog?.(line));
  } catch (e) {
    // База недоступна с первого шага — обхода не будет, но исключением никого не роняем:
    // и CLI, и резидент должны увидеть внятную строку, а не стек.
    const text = String(e?.message ?? e).split("\n")[0];
    log(`обход не начался: ${text}`);
    notice("run", `обход не начался: ${text}`);
    // Строки в базе нет, но сказать владельцу надо тем более: сайт тоже читает из базы.
    await reportRun({ runId: null, trigger, depth, depthFrom, depthTo, done: 0, failed: 0, slotLabel, log });
    return { runId: null, ok: false, done: 0, failed: 0, error: text, failures, depth, log: lines.join("\n") };
  }
  const who = failedOnly ? "только неудавшиеся" : creatorId ? `креатор ${creatorId}` : "все";
  log(`обход #${runId} (${trigger}, ${who}, глубина ${label}, комментарии ${comments ? "да" : "нет"}, ветки ${replies ? "да" : "нет"}${allVideos ? ", и не наши видео" : ""}${videos === "ours" ? " · только наши" : ""}${maxVideos !== null ? ` · до ${maxVideos} видео` : ""}${env.direct ? "" : " · прямые запросы выключены"})`);

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
  const flags = { comments, replies, allVideos, videos, maxVideos };
  try {
    const where = `${creatorId ? `&id=eq.${creatorId}` : ""}${failedOnly ? "&sync_error=not.is.null" : ""}`;
    const creators = await get(`creators?select=${CREATOR_FIELDS}${where}&order=sort_order.asc,added_at.asc`);
    if (creators.length === 0) {
      log(failedOnly ? "ни у кого нет ошибки — повторять нечего" : creatorId ? "креатор не найден в базе" : "в базе нет ни одного креатора");
    }

    // Полосы известны заранее: по ним считается и оценка, и остаток каждой в прогнозе.
    const lanes = splitLanes(creators);

    // --- Оценка объёма (миграция v24) --------------------------------------------------------
    // Считается ОДИН раз, до первого браузера, по тому, что уже лежит в базе. Не вышло — обход
    // идёт как прежде, просто без полосы прогресса: оценка это подсказка, а не результат.
    let timing = readTiming();
    let estimate = null;
    // Правда ли в базе есть колонки v24. Нет — перестаём их слать в этом обходе целиком.
    let estimateColumns = true;
    let estimateDirty = false;
    const estOf = new Map();
    // Работа по полосам: они идут одновременно, и остаток у каждой свой.
    const laneWork = { tt: { total: 0, done: 0, startedAt: null }, ig: { total: 0, done: 0, startedAt: null } };
    if (creators.length > 0) {
      try {
        estimate = await estimateWork(creators, env, depth, bounds, flags, timing);
        for (const e of estimate.byCreator) estOf.set(e.creatorId, e);
        for (const kind of ["tt", "ig"]) {
          laneWork[kind].total = lanes[kind].reduce((sum, c) => sum + (estOf.get(String(c.id))?.total ?? 0), 0);
        }
        estimateDirty = true;
        const mins = (s) => Math.max(1, Math.round(s / 60));
        const listSum = estimate.byCreator.reduce((s, e) => s + e.list, 0);
        const commSum = estimate.byCreator.reduce((s, e) => s + e.comments + e.replies, 0);
        log(`оценка объёма: ~${mins(estimate.total)} мин (список ~${mins(listSum)}, комментарии ~${mins(commSum)}); полосы: TikTok ~${mins(laneWork.tt.total)}, Instagram ~${mins(laneWork.ig.total)}`);
      } catch (e) {
        log(`объём обхода не оценился: ${short(e)} — идём без полосы прогресса`);
      }
    }
    /** Похожа ли беда патча на «колонок v24 в базе ещё нет». */
    const noColumns = (e) => /HTTP 400|PGRST204|PGRST102|column .* does not exist|не удалось найти столбец/i.test(String(e?.message ?? e));

    /**
     * Ход обхода для сайта (миграция v14; владелец, 2026-09-09: «что за обход, сколько
     * выполнено, на сколько ещё»). После каждого креатора в `sync_runs` уезжают счётчики и
     * те, кого собираем сейчас — по одному на полосу. Не уехало — обход не страдает: это
     * подсказка на кнопке, а не результат.
     * ⚠️ В `current` кладётся ГОТОВАЯ строка для сайта, а не голый handle: полоса TikTok на
     * время паузы по лимиту запусков пишет туда «пауза TikTok до HH:MM», и «@» перед этим
     * был бы бессмыслицей.
     */
    const current = new Map();
    let progressFailed = 0;
    /** Секунды в базу — до десятых: numeric, а не целое, и читать её будет человек. */
    const round1 = (n) => Math.round(n * 10) / 10;
    async function progress() {
      if (!runId) return;
      const body = {
        creators_total: creators.length,
        creators_done: done,
        creators_failed: failed,
        current_handles: [...current.values()],
        progress_at: new Date().toISOString(),
      };
      // Оценка и прогноз (миграция v24). Прогноз — по полосам: они идут одновременно, значит
      // обход кончится тогда, когда закончит самая долгая, а не когда сложится их работа.
      if (estimate && estimateColumns) {
        body.work_total = round1(estimate.total);
        body.work_done = round1(laneWork.tt.done + laneWork.ig.done);
        const at = Date.now();
        const lane = (kind) => ({
          total: laneWork[kind].total,
          done: laneWork[kind].done,
          elapsedMs: laneWork[kind].startedAt === null ? 0 : at - laneWork[kind].startedAt,
        });
        body.eta_at = new Date(at + etaSeconds([lane("tt"), lane("ig")]) * 1000).toISOString();
        // Разбивка уезжает не каждый раз: меняется она только когда креатор кончился.
        if (estimateDirty) body.estimate = estimate.byCreator.map(({ creatorId, ...rest }) => rest);
      }
      try {
        await patch(`sync_runs?id=eq.${runId}`, body);
        if (body.estimate) estimateDirty = false;
      } catch (e) {
        // Колонок v24 в базе ещё нет — перестаём их слать вовсе и повторяем патч без них:
        // счётчики креаторов сайту нужны в любом случае.
        if (estimate && estimateColumns && noColumns(e)) {
          estimateColumns = false;
          log(`оценка объёма в базу не пошла (${short(e)}) — миграции v24 ещё нет, обход идёт без полосы прогресса`);
          await progress();
          return;
        }
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
      // Кого полоса собирает прямо сейчас — чтобы строка журнала знала своего креатора.
      let who = null;
      const say = (text) => log(`${cfg.tag} ${text}`, { source: "browser", handle: who });
      const startedLane = Date.now();
      // Отсчёт скорости полосы — отсюда: до первого креатора она ничего не делала.
      laneWork[kind].startedAt = startedLane;
      let laneDone = 0;
      say(`полоса ${cfg.name}: креаторов ${list.length}`);
      try {
        for (let i = 0; i < list.length; i++) {
          const creator = list[i];
          who = creator.handle;
          say(`@${creator.handle} (${creator.platform})`);
          current.set(kind, `@${creator.handle}`);
          await progress();
          // Полоса TikTok поднимает ЧИСТЫЙ профиль на каждого креатора, а таких запусков с
          // ОДНОГО АДРЕСА площадка терпит немного. Пул выбирает следующий адрес по кругу, а если
          // свободных нет — ждёт ближайшего освобождения; ожидание видно и в журнале, и на кнопке
          // сайта. Полосу Instagram оно не задевает вовсе: полосы идут через Promise.all.
          // ⚠️ Адрес берётся не здесь, а внутри шага списка (`tiktok.mjs`): после пустого списка
          // ему нужен СЛЕДУЮЩИЙ адрес, а не тот же самый.
          const pool = kind !== "tt" ? null : {
            async take({ exclude = [] } = {}) {
              const { address } = await takeLaunchSlot({
                limit: env.ttLaunchLimit,
                windowMs: env.ttWindowMs,
                addresses: env.proxyAddresses,
                exclude,
                onWait: (until, waitMs, info) => {
                  const why = info?.addresses > 1
                    ? "все адреса заняты"
                    : `${env.ttLaunchLimit} запусков за ${Math.round(env.ttWindowMs / 60_000)} мин`;
                  say(`ждём паузу TikTok до ${hhmm(until)} (${why})`);
                  current.set(kind, `пауза TikTok до ${hhmm(until)}`);
                  void progress();
                },
                onFree: (waited, address) => {
                  say(`пауза TikTok кончилась, ждали ${Math.round(waited / 60_000)} мин, адрес: ${address.label}`);
                  current.set(kind, `@${creator.handle}`);
                  void progress();
                },
              });
              return address;
            },
            bad(id, why) {
              // ⚠️ Адрес один — паузы не ставим вовсе: она остановила бы весь обход на полчаса
              // ради беды, которая и так лечится ожиданием следующего слота. Это и есть
              // «с одним адресом — поведение как сейчас».
              if ((env.proxyAddresses?.length ?? 1) < 2) return;
              const until = rememberBad(id, env.proxyCooldownMs);
              say(`  ${labelOf(env.proxyAddresses, id)} в паузе до ${hhmm(new Date(until))}: ${why}`);
            },
            good(id) {
              rememberGood(id);
            },
          };
          const started = Date.now();
          let error = null;
          // Ход этого креатора: сколько его секунд уже засчитано. Оценки нет — счётчика нет
          // вовсе, и полоса прогресса просто не двигается.
          const est = estOf.get(String(creator.id)) ?? null;
          let creatorDone = 0;
          const addWork = (seconds) => {
            if (!(seconds > 0)) return;
            creatorDone += seconds;
            laneWork[kind].done += seconds;
          };
          // Какими единицами считается шаг комментариев у ЭТОГО креатора. Оценка считала теми
          // же (`estimateCreator`), иначе полоса прогресса разъехалась бы с собственной оценкой.
          const keys = commentKeys(env.direct && (creator.platform ?? "tiktok") === "tiktok");
          const work = est === null ? null : {
            list() {
              addWork(est.list);
              void progress();
            },
            commentVideo() {
              // Цена одного видео берётся из ЖИВОЙ калибровки: она могла подвинуться на
              // прошлых креаторах этого же обхода.
              addWork(timing[keys.video] + (flags.replies ? timing[keys.replies] : 0));
              void progress();
            },
          };
          try {
            const res = await collectOne(creator, env, depth, bounds, lane, flags, say, pool, work);
            done++;
            laneDone++;
            say(`  готово: видео ${res.videos}, подписчиков ${res.followers ?? "?"}`);
            // Калибровка по факту (миграция v24): шаг списка раскладывается на «запуск» и
            // «прокрутку», шаг комментариев — на цену видео. Площадка не сказала числа
            // прокруток (Graph API их не делает) — шаг списка в калибровку не идёт.
            if (res.listMs > 0 && res.pages !== null) {
              timing = calibrateList(timing, creator.platform, res.listMs / 1000, res.pages);
            }
            // Пути шага комментариев калибруются ПОРОЗНЬ: прямой стоит секунды, браузерный —
            // десятки секунд, и одно среднее на двоих испортило бы обе цены. Видео, которое
            // ходило обоими путями, целиком считается браузерным: браузер в нём и стоит.
            if (res.directVideos > 0 && res.directMs > 0) {
              timing = calibrateComments(timing, res.directMs / 1000, res.directVideos, flags.replies, undefined, true);
            }
            if (res.browserVideos > 0 && res.browserMs > 0) {
              timing = calibrateComments(timing, res.browserMs / 1000, res.browserVideos, flags.replies, undefined, false);
            }
            const bad = writeTiming(timing);
            if (bad) say(`  калибровка не записалась: ${bad}`);
            const paths = [
              res.directVideos > 0 ? `прямых ${res.directVideos} за ${Math.round(res.directMs / 1000)} с` : null,
              res.browserVideos > 0 ? `браузером ${res.browserVideos} за ${Math.round(res.browserMs / 1000)} с` : null,
            ].filter(Boolean).join(", ");
            say(`  время: список ${Math.round(res.listMs / 1000)} с${res.pages === null ? "" : ` (${res.pages} прокруток)`}${res.commentVideos > 0 ? `, комментарии ${Math.round(res.commentsMs / 1000)} с на ${res.commentVideos} видео${paths ? ` (${paths})` : ""}` : ""}`);
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
          who = null;
          // Креатор кончился — чем бы ни кончился, его остаток засчитывается: иначе полоса
          // прогресса застряла бы на упавшем и на том, кому оценка насчитала лишнего.
          if (est !== null) {
            addWork(est.total - creatorDone);
            est.done = true;
            estimateDirty = true;
          }
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
    await reportRun({ runId, trigger, depth, depthFrom, depthTo, done, failed, slotLabel: failed > 0 || firstError ? slotLabel ?? null : null, log });
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
    // Живой журнал закрывается последним и всегда: остаток строк должен лечь в `sync_log`,
    // чем бы обход ни кончился. Своих исключений он не бросает.
    await stopSyncLog();
  }
}

/**
 * Один обход. Пока идёт предыдущий — ждёт его в очереди.
 * `{ trigger: 'schedule'|'catchup'|'manual'|'retry', creatorId?, failedOnly?, depth?, depthFrom?,
 *    depthTo?, videos?, maxVideos?, comments?, replies?, allVideos?, requestedBy?, requestIds?,
 *    slotLabel?, onLog? }`
 * `depth` — 'all' (по умолчанию) | 'week' | 'month' | 'range' (миграция v18); у 'range'
 * обязательны обе границы `depthFrom` / `depthTo` (ISO или Date) — без них глубина опускается
 * до 'all' (`normalizeDepth` в `scope.mjs`), и это видно строкой в логе обхода;
 * `videos` — охват списка: `'all'` (по умолчанию, как ходят расписание, догон и повтор) или
 * `'ours'` — листать лишь до тех пор, пока не встретились все наши и жёлтые видео креатора;
 * `maxVideos` — потолок: не больше стольких самых новых видео на креатора в пределах глубины
 * (миграция v19). Пусто, ноль и мусор — `null`, потолка нет; расписание, догон и повтор после
 * слота ходят без него всегда. Отслеживаемые видео потолок не режет (`scope.mjs`);
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
export function runSync({ trigger = "manual", creatorId = null, failedOnly = false, depth = "all", depthFrom = null, depthTo = null, videos = "all", maxVideos = null, comments = true, replies = true, allVideos = false, requestedBy = null, requestIds = [], slotLabel = null, onLog } = {}) {
  // Глубина приводится к одному из четырёх видов ЗДЕСЬ и один раз: дальше по обходу ходит уже
  // разобранная пара «глубина + границы», и в базу ложится ровно она.
  const norm = normalizeDepth(depth, depthFrom, depthTo);
  if (norm.note) onLog?.(`глубина: ${norm.note}`);
  const args = {
    trigger, creatorId, failedOnly,
    depth: norm.depth,
    depthFrom: norm.from,
    depthTo: norm.to,
    // Всё, кроме прямого «только наши», — полный охват: у колонки в базе тоже default 'all'.
    videos: videos === "ours" ? "ours" : "all",
    // Потолок приводится к виду «целое больше нуля или null» ЗДЕСЬ и один раз — дальше по
    // обходу и в базу ходит уже разобранное число (`scope.mjs`).
    maxVideos: videoCap(maxVideos),
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

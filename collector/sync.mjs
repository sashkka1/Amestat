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
//     на одного креатора гарантированно дают пустые ответы.
//   • Глубина (`depth`) обхода целиком передаётся сборщикам площадок: 'all' — весь список
//     видео, 'week' — только за последние 7 дней. Снимок профиля делается всегда одинаково.
//   • Повтор после неудачи (`failedOnly`) берёт только тех, у кого в `creators.sync_error`
//     что-то есть: успевшие собраться второй раз за час не тревожатся.
//   • Тексты комментариев — отдельный шаг ПОСЛЕ снимков видео и только по свежим роликам
//     (`AMESTAT_COMMENTS_DAYS`, у которых комментарии вообще есть). Он ходит вторым браузером,
//     под сессией фейкового аккаунта, и ошибка на видео обход не валит: снимки уже записаны.
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
import { launchProfile, trimTraffic } from "./browser.mjs";
import { rehostImage, isOurs, avatarPath, coverPath } from "./images.mjs";
import { notice, startRun, reportRun } from "./notices.mjs";

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

// Очередь в процессе: следующий обход ждёт, пока закончится текущий.
let chain = Promise.resolve();
let pending = 0;

/** Кто собирает этого креатора. Instagram — по IG_SOURCE (graph | web). */
function pickCollector(creator, env, depth) {
  const platform = creator.platform ?? "tiktok";
  if (platform === "tiktok") {
    return (log) => collectTikTok(creator, { browserChoice: env.browser, retryPauseMs: env.pauseMs, depth, log });
  }
  if (platform === "instagram") {
    if (env.igSource === "graph") {
      return (log) => collectInstagramGraph(creator, { token: env.igToken, userId: env.igUserId, depth, log });
    }
    return (log) => collectInstagramWeb(creator, { browserChoice: env.browser, depth, log });
  }
  throw new Error(`неизвестная площадка: ${platform}`);
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
 * Тексты комментариев к свежим видео креатора — второй заход браузером, уже под сессией
 * фейкового аккаунта (постоянный профиль `profile-opera`). Число комментариев к этому моменту
 * уже лежит в `video_snaps.comments`; здесь собираются сами тексты.
 *
 * Правила шага:
 *   • берутся только видео за последние `AMESTAT_COMMENTS_DAYS` дней и только те, у которых
 *     комментарии есть вовсе: у старых обсуждение уже не растёт, у пустых брать нечего;
 *   • браузер открывается ОДИН на креатора и закрывается в `finally` — профиль постоянный,
 *     второй процесс на этой папке не встанет;
 *   • TikTok водится с настоящим окном: в скрытом он отдаёт пустые тела и капчу (см.
 *     `comments-tiktok.mjs`). Instagram обходится скрытым;
 *   • ошибка одного видео шаг не валит, обход не роняет и `creators.sync_error` не ставит:
 *     комментарии — добавка к снимкам, а не их условие;
 *   • вместе с корневыми снимаются и ответы под ними (`parent_id` = id корневого, не больше
 *     `AMESTAT_REPLIES_MAX` на ветку) — они ложатся в ту же таблицу тем же upsert'ом.
 */
async function collectComments(creator, videos, env, log) {
  const platform = creator.platform ?? "tiktok";
  const collect = platform === "tiktok" ? collectTikTokComments
    : platform === "instagram" ? collectInstagramComments
      : null;
  if (!collect) return;

  const since = Date.now() - env.commentsDays * DAY_MS;
  const picked = videos.filter((v) => (v.comments ?? 0) > 0 && v.publishedAt !== null && Date.parse(v.publishedAt) >= since);
  if (picked.length === 0) {
    log?.(`  комментарии: видео 0, собрано 0, не вышло 0 (свежих с комментариями нет за ${env.commentsDays} дн.)`);
    return;
  }

  const headless = platform !== "tiktok";
  let browser = null;
  try {
    // Предыдущий браузер только что закрылся, и Opera на его хвосте поднимается через раз —
    // даём процессу уйти совсем, а не спорим с ним за профиль.
    await sleep(COMMENTS_PAUSE_MS);
    browser = await launchProfile(env.browser, { headless, log });
  } catch (e) {
    // Нет профиля или не поднялся браузер — снимки уже записаны, обход этим не портим.
    const text = String(e?.message ?? e).split("\n")[0];
    log?.(`  комментарии: ${text}`);
    notice("comments", `@${creator.handle}: браузер для комментариев не поднялся — ${text}`);
    return;
  }
  log?.(`  комментарии: браузер ${browser.describe}${headless ? "" : ", окно настоящее — скрытому TikTok их не отдаёт"}`);
  // Чужие хосты, видео и шрифты в этот браузер не пускаем: он живёт всё время шага и
  // на странице видео разрастался до полусотни процессов.
  let traffic = null;
  try {
    traffic = await trimTraffic(browser.ctx, platform === "tiktok" ? HOSTS_TIKTOK : HOSTS_INSTAGRAM, { log });
  } catch (e) {
    // Не поставился перехват — шаг всё равно идёт, просто прожорливее.
    log?.(`  лишнее отсечь не вышло: ${String(e?.message ?? e).split("\n")[0]}`);
  }

  let rows = 0, answers = 0, failed = 0;
  try {
    for (let i = 0; i < picked.length; i++) {
      const video = picked[i];
      try {
        const list = await collect(
          browser.ctx,
          { id: video.id, url: video.url, creatorHandle: creator.handle },
          { max: env.commentsMax, repliesMax: env.repliesMax, log },
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
        await patch(`videos?id=eq.${encodeURIComponent(video.id)}`, { comments_synced_at: now });
        rows += list.length;
        answers += list.filter((c) => c.parentId).length;
      } catch (e) {
        failed++;
        const text = String(e?.message ?? e).split("\n")[0];
        log?.(`    видео ${video.id}: ${text}`);
        notice("comments", `@${creator.handle} видео ${video.id}: ${text}`);
      }
      if (i < picked.length - 1) await sleep(COMMENTS_PAUSE_MS);
    }
  } finally {
    // Окно закрывается всегда и здесь же: профиль один на машину, и оставленный браузер
    // не даст подняться следующему обходу.
    await browser.cleanup();
  }
  const seen = traffic?.() ?? null;
  log?.(`  комментарии: видео ${picked.length}, собрано ${rows} (ответов ${answers}), не вышло ${failed}${seen ? `, лишних запросов отсечено ${seen.aborted}` : ""}`);
}

async function collectOne(creator, env, depth, log) {
  const collect = pickCollector(creator, env, depth);
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
    await collectComments(creator, videos, env, log);
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

async function doSync({ trigger, creatorId, failedOnly, depth, requestedBy, requestIds, slotLabel, onLog }) {
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
  log(`обход #${runId} (${trigger}, ${who}, глубина ${depth === "week" ? "неделя" : "всё"})`);

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
  try {
    const where = `${creatorId ? `&id=eq.${creatorId}` : ""}${failedOnly ? "&sync_error=not.is.null" : ""}`;
    const creators = await get(`creators?select=${CREATOR_FIELDS}${where}&order=sort_order.asc,added_at.asc`);
    if (creators.length === 0) {
      log(failedOnly ? "ни у кого нет ошибки — повторять нечего" : creatorId ? "креатор не найден в базе" : "в базе нет ни одного креатора");
    }

    for (let i = 0; i < creators.length; i++) {
      const creator = creators[i];
      log(`@${creator.handle} (${creator.platform})`);
      const started = Date.now();
      try {
        const res = await collectOne(creator, env, depth, log);
        done++;
        log(`  готово: видео ${res.videos}, подписчиков ${res.followers ?? "?"}`);
      } catch (e) {
        failed++;
        const text = String(e?.message ?? e).split("\n")[0];
        failures.push({ handle: creator.handle, error: text });
        firstError = firstError ?? `@${creator.handle}: ${text}`;
        log(`  ошибка: ${text}`);
        notice("creator", `@${creator.handle}: ${text}`);
        try {
          await patch(`creators?id=eq.${creator.id}`, { sync_error: text });
        } catch (e2) {
          const text2 = String(e2?.message ?? e2).split("\n")[0];
          log(`  не записалась и ошибка креатора: ${text2}`);
          notice("db", `@${creator.handle}: не записалась и ошибка креатора — ${text2}`);
        }
      }
      const spent = Date.now() - started;
      if (spent > SLOW_CREATOR_MS) notice("slow", `@${creator.handle}: собирался ${Math.round(spent / 60_000)} мин`);
      // Пауза только между креаторами: TikTok не любит запуски подряд.
      if (i < creators.length - 1 && env.pauseMs > 0) {
        log(`  пауза ${Math.round(env.pauseMs / 1000)} с`);
        await sleep(env.pauseMs);
      }
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
 *    requestedBy?, requestIds?, slotLabel?, onLog? }`
 * `slotLabel` — час неудавшегося слота у повтора: если и повтор не удался, письмо обхода
 * получает строку «вторая неудача подряд после слота HH:MM» и второго письма не бывает.
 * Отдаёт `{ runId, ok, done, failed, error, failures, depth, log }` — исключений не бросает.
 * `failures` — `[{ handle, error }]` по каждому неудавшемуся креатору: из них резидент
 * собирает сообщение владельцу в Telegram.
 */
export function runSync({ trigger = "manual", creatorId = null, failedOnly = false, depth = "all", requestedBy = null, requestIds = [], slotLabel = null, onLog } = {}) {
  const args = { trigger, creatorId, failedOnly, depth: depth === "week" ? "week" : "all", requestedBy, requestIds, slotLabel, onLog };
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

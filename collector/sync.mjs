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
//   • Картинки Instagram на чужих адресах не остаются: аватар и обложки перекладываются в
//     свой бакет (`images.mjs`), в базу идёт наш публичный адрес. Причина — в `images.mjs`;
//     у TikTok картинки показываются как есть, и его это не касается вовсе.

import { get, patch, insertMany, insertReturning, upsert } from "./db.mjs";
import { loadEnv } from "./env.mjs";
import { collectTikTok } from "./tiktok.mjs";
import { collectInstagramGraph } from "./instagram-graph.mjs";
import { collectInstagramWeb } from "./instagram-web.mjs";
import { rehostImage, isOurs, avatarPath, coverPath } from "./images.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CREATOR_FIELDS = "id,platform,handle,display_name,avatar_custom,sort_order,added_at";
const COVERS_PARALLEL = 4;    // столько обложек качаем разом
const COVERS_PAUSE_MS = 100;  // и пауза между пачками: чужой CDN не любит очередь запросов подряд

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
    log?.(`  прежние обложки не спросились: ${String(e?.message ?? e).split("\n")[0]}`);
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

async function doSync({ trigger, creatorId, failedOnly, depth, requestedBy, requestIds, onLog }) {
  const env = loadEnv();
  const lines = [];
  const log = (text) => {
    lines.push(text);
    onLog?.(text);
  };
  const failures = [];

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
      log(`просьбы не помечены: ${String(e?.message ?? e).split("\n")[0]}`);
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
        try {
          await patch(`creators?id=eq.${creator.id}`, { sync_error: text });
        } catch (e2) {
          log(`  не записалась и ошибка креатора: ${String(e2?.message ?? e2).split("\n")[0]}`);
        }
      }
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
    firstError = firstError ?? text;
    return { runId, ok: false, done, failed, error: firstError, failures, depth, log: lines.join("\n") };
  } finally {
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
        onLog?.(`итог обхода не записался: ${String(e?.message ?? e).split("\n")[0]}`);
      }
    }
  }
}

/**
 * Один обход. Пока идёт предыдущий — ждёт его в очереди.
 * `{ trigger: 'schedule'|'catchup'|'manual'|'retry', creatorId?, failedOnly?, depth?,
 *    requestedBy?, requestIds?, onLog? }`
 * Отдаёт `{ runId, ok, done, failed, error, failures, depth, log }` — исключений не бросает.
 * `failures` — `[{ handle, error }]` по каждому неудавшемуся креатору: из них резидент
 * собирает сообщение владельцу в Telegram.
 */
export function runSync({ trigger = "manual", creatorId = null, failedOnly = false, depth = "all", requestedBy = null, requestIds = [], onLog } = {}) {
  const args = { trigger, creatorId, failedOnly, depth: depth === "week" ? "week" : "all", requestedBy, requestIds, onLog };
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

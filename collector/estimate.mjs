// Оценка объёма обхода и калибровка. Владелец, 2026-09-09: «сначала одним заходом оценить
// объём работы (число видео и т. п.), а потом показывать маленький график 0–100 %, насколько
// мы близки к завершению — „6 из 10 креаторов“ ничего не говорит: может, прошли шесть самых
// быстрых».
//
// 🔴 Единица работы здесь — СЕКУНДА, а не «видео» и не «креатор». Только в секундах разные
// шаги складываются в одну шкалу: полоса TikTok на одном креаторе стоит минуту, а шаг
// комментариев у соседа — полчаса, и в штуках эти двое несравнимы.
//
// Из чего складывается оценка одного креатора:
//   • шаг списка — база (`list.tiktok` / `list.instagram`: запуск браузера и первая страница)
//     плюс `page.*` × ожидаемое число прокруток. Прокрутки считаются по тому, что уже лежит в
//     базе: сколько у креатора известных видео, сколько из них попадает в глубину, докуда
//     листать до самого старого отслеживаемого при охвате «только наши», и режет ли потолок;
//   • шаг комментариев — `comments.video` × число видео-кандидатов (правило `pickComments`) и
//     столько же `replies.video`, если ветки раскрываются.
//
// ⚠️ Кандидаты считаются ВСЕ, включая те, что на месте окажутся «без изменений»: сколько их
// будет, знает только прошлый счётчик комментариев площадки, а он приезжает уже во время шага.
// Оценка поэтому завышена сверху — и это лучше, чем полоса, доезжающая до 100 % и стоящая.
//
// Калибровка (`logs/timing-state.json`): скользящее среднее (EMA, α = 0.3) фактических секунд
// на единицу. Сборщик замеряет шаг списка и шаг комментариев по ходу и обновляет файл в конце
// каждого креатора. До первой калибровки берутся умолчания ниже — они с глаз, по журналам
// обходов 8–9 сентября.
//
// ⚠️ Файл общий на все процессы (резидент и разовый `run.mjs`), как `tiktok-launches.json`:
// он читается перед записью и пишется целиком. Гонка здесь ничего не стоит — потеряется одно
// измерение из многих.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { collectorDir } from "./env.mjs";

export const TIMING_FILE = resolve(collectorDir, "logs", "timing-state.json");

/** Насколько свежее измерение двигает среднее. 0.3 — три-четыре обхода до полной смены. */
export const TIMING_ALPHA = 0.3;

/**
 * Секунды на единицу до первой калибровки. Ключи — единственные, которые понимает сборщик:
 * лишнее из файла отбрасывается, недостающее берётся отсюда.
 */
export const DEFAULT_TIMING = {
  "list.tiktok": 60,
  "page.tiktok": 6,
  "list.instagram": 20,
  "page.instagram": 5,
  "comments.video": 25,
  "replies.video": 40,
  // Прямой запрос (`direct.mjs`, владелец 2026-09-10) — тот же шаг без браузера: страница
  // комментариев приезжает за полсекунды-полторы, ветки — столько же на ветку. Умолчания с
  // запасом: 2 с на видео и 3 с на его ветки. ⚠️ Оценка берёт ИХ, когда прямой путь включён;
  // видео, откатившееся на браузер, окажется дороже оценки — полоса просто пойдёт медленнее.
  "comments.direct": 2,
  "replies.direct": 3,
};

export const TIMING_KEYS = Object.keys(DEFAULT_TIMING);

/**
 * Сколько видео приходит за одну прокрутку списка. У TikTok страница ответа — 20 роликов,
 * у Instagram — 12. Числа нужны только оценке: сама прокрутка идёт до конца списка, а не по
 * счётчику.
 */
export const PER_SCROLL = { tiktok: 20, instagram: 12 };

/**
 * Какой парой единиц считается шаг комментариев: прямым запросом или браузером.
 * Одно место на весь модуль и на `sync.mjs` — иначе оценка считала бы одними ключами, а
 * калибровка правила бы другие, и полоса прогресса разъехалась бы молча. Чистая функция.
 */
export function commentKeys(direct = false) {
  return direct === true
    ? { video: "comments.direct", replies: "replies.direct" }
    : { video: "comments.video", replies: "replies.video" };
}

/** Площадка к одному из двух слов: чужая и пустая считаются TikTok — как `laneOf` в `sync.mjs`. */
export function platformOf(value) {
  return String(value ?? "tiktok").trim().toLowerCase() === "instagram" ? "instagram" : "tiktok";
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Калибровка в понятном виде: все ключи `TIMING_KEYS` на месте, мусор и пропажи заменены
 * умолчаниями (лишнее из файла отбрасывается — так добавились `*.direct`, и старый файл
 * калибровки читается без единой правки).
 * Чистая функция: её проверяют тесты.
 */
export function normalizeTiming(raw) {
  const out = {};
  for (const key of TIMING_KEYS) out[key] = num(raw?.[key]) ?? DEFAULT_TIMING[key];
  return out;
}

/**
 * Скользящее среднее: новое значение тянет старое на `alpha`.
 * Прошлого нет или измерение негодное — отдаём то, что есть. Чистая функция.
 */
export function foldEma(prev, actual, alpha = TIMING_ALPHA) {
  const now = num(actual);
  if (now === null) return num(prev) ?? null;
  const was = num(prev);
  if (was === null) return now;
  const a = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : TIMING_ALPHA;
  return was * (1 - a) + now * a;
}

/**
 * Калибровка после шага списка: `seconds` — сколько шаг занял, `pages` — сколько прокруток
 * успел сделать.
 *
 * ⚠️ Одно измерение и два неизвестных (база и цена прокрутки), поэтому делится оно не
 * поровну, а ПО НЫНЕШНЕЙ ПРОПОРЦИИ: обе цены двигаются одним и тем же множителем
 * `факт / предсказание`. Так шаг, занявший вдвое больше ожидаемого, поднимает обе цены вдвое,
 * а их отношение остаётся тем, что заложено умолчаниями. Прокруток не было вовсе — вся
 * секунда идёт в базу, и это единственный случай, когда цена прокрутки не двигается.
 * Чистая функция.
 */
export function calibrateList(timing, platform, seconds, pages, alpha = TIMING_ALPHA) {
  const t = normalizeTiming(timing);
  const spent = num(seconds);
  if (spent === null) return t;
  const plat = platformOf(platform);
  const baseKey = `list.${plat}`, pageKey = `page.${plat}`;
  const p = Math.max(0, Math.round(Number(pages) || 0));
  if (p === 0) return { ...t, [baseKey]: foldEma(t[baseKey], spent, alpha) };
  const predicted = t[baseKey] + p * t[pageKey];
  if (!(predicted > 0)) return t;
  const scale = spent / predicted;
  return {
    ...t,
    [baseKey]: foldEma(t[baseKey], t[baseKey] * scale, alpha),
    [pageKey]: foldEma(t[pageKey], t[pageKey] * scale, alpha),
  };
}

/**
 * Калибровка после шага комментариев: `seconds` — весь шаг, `videos` — сколько видео он обошёл,
 * `withReplies` — раскрывались ли ветки.
 * Ветки не раскрывались — измеряется чистая цена видео. Раскрывались — измерение накрывает обе
 * цены разом, и они двигаются одним множителем, как база и прокрутка выше. Чистая функция.
 */
export function calibrateComments(timing, seconds, videos, withReplies = true, alpha = TIMING_ALPHA, direct = false) {
  const t = normalizeTiming(timing);
  const spent = num(seconds);
  const n = Math.max(0, Math.round(Number(videos) || 0));
  if (spent === null || n === 0) return t;
  // Пути два и цены у них разные на порядок, поэтому и калибруются они порознь: замер прямого
  // пути не имеет права утянуть вниз цену браузерного, и наоборот (`commentKeys`).
  const { video: videoKey, replies: repliesKey } = commentKeys(direct);
  const perVideo = spent / n;
  if (!withReplies) return { ...t, [videoKey]: foldEma(t[videoKey], perVideo, alpha) };
  const predicted = t[videoKey] + t[repliesKey];
  if (!(predicted > 0)) return t;
  const scale = perVideo / predicted;
  return {
    ...t,
    [videoKey]: foldEma(t[videoKey], t[videoKey] * scale, alpha),
    [repliesKey]: foldEma(t[repliesKey], t[repliesKey] * scale, alpha),
  };
}

/** Калибровка из файла. Файла нет или он испорчен — умолчания. */
export function readTiming(file = TIMING_FILE) {
  try {
    return normalizeTiming(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULT_TIMING };
  }
}

/**
 * Калибровка в файл, округлённая до десятых: читать её будет человек.
 * Не записалась — работу не валим: следующий обход просто посчитает по прежним числам.
 */
export function writeTiming(timing, file = TIMING_FILE) {
  try {
    const t = normalizeTiming(timing);
    const out = {};
    for (const key of TIMING_KEYS) out[key] = Math.round(t[key] * 10) / 10;
    mkdirSync(resolve(collectorDir, "logs"), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
    return null;
  } catch (e) {
    return String(e?.message ?? e).split("\n")[0];
  }
}

/** Момент в мс из ISO-строки; пусто и мусор — null. */
function msOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Ожидаемое число прокруток списка у одного креатора.
 *   • `mode` 'ours' — листаем до САМОГО СТАРОГО отслеживаемого: сколько видео лежит от начала
 *     ленты до него, столько и придётся пройти. Ни глубина, ни потолок здесь не при чём —
 *     `scope.mjs` их при 'ours' не применяет;
 *   • глубина 'all' — все известные видео креатора;
 *   • 'week' / 'month' / 'range' — только те, что попали в границы;
 *   • потолок режет число видео (и только вне 'ours').
 * Меньше одной прокрутки не бывает: первая страница приезжает всегда.
 * Чистая функция.
 */
export function listScrolls({
  platform = "tiktok",
  mode = "all",
  depth = "all",
  videosTotal = 0,
  inDepth = 0,
  toTracked = 0,
  maxVideos = null,
} = {}) {
  const per = PER_SCROLL[platformOf(platform)];
  const cap = num(maxVideos);
  let n;
  if (mode === "ours") n = Math.max(0, Number(toTracked) || 0);
  else {
    n = String(depth ?? "all") === "all"
      ? Math.max(0, Number(videosTotal) || 0)
      : Math.max(0, Number(inDepth) || 0);
    if (cap !== null) n = Math.min(n, cap);
  }
  return Math.max(1, Math.ceil(n / per));
}

/**
 * Оценка одного креатора в секундах: `{ handle, list, comments, replies, total }`.
 * `scrolls` — из `listScrolls`, `commentVideos` — сколько видео возьмёт шаг комментариев.
 * Чистая функция.
 */
export function estimateCreator({
  handle = "",
  platform = "tiktok",
  scrolls = 1,
  commentVideos = 0,
  comments = true,
  replies = true,
  direct = false,
} = {}, timing = DEFAULT_TIMING) {
  const t = normalizeTiming(timing);
  const plat = platformOf(platform);
  const pages = Math.max(1, Math.round(Number(scrolls) || 1));
  const videos = comments ? Math.max(0, Math.round(Number(commentVideos) || 0)) : 0;
  const list = t[`list.${plat}`] + pages * t[`page.${plat}`];
  // Прямой путь есть только у TikTok: у Instagram комментарии по-прежнему целиком браузерные.
  const keys = commentKeys(direct === true && plat === "tiktok");
  const comm = videos * t[keys.video];
  const rep = replies ? videos * t[keys.replies] : 0;
  const round = (n) => Math.round(n * 10) / 10;
  return {
    handle,
    list: round(list),
    comments: round(comm),
    replies: round(rep),
    total: round(list + comm + rep),
  };
}

/**
 * Кандидат ли это видео на шаг комментариев — то же правило, что в `pickComments` (`sync.mjs`),
 * но по строкам базы и без «без изменений»: прошлый счётчик знает только сам шаг.
 * `row` — `{ published_at, ours, watch }`, `comments` — счётчик последнего снимка.
 * Чистая функция.
 */
export function commentCandidate(row, comments, { since = null, until = null, allVideos = false } = {}) {
  if (!(Number(comments) > 0)) return false;
  const at = msOf(row?.published_at);
  // Границ нет вовсе (глубина «всё») — дата не нужна: берём весь список, как и `pickComments`.
  if (since !== null || until !== null) {
    if (at === null) return false;
    if (since !== null && at < since) return false;
    if (until !== null && at > until) return false;
  }
  // Чужие и жёлтые текстов не получают — ровно как в `pickComments`. Строки без поля `ours`
  // считаются нашими: лишняя работа в оценке лучше заниженной полосы.
  if (!allVideos && row?.ours === false) return false;
  return true;
}

/**
 * Окно шага комментариев в мс — РОВНО границы глубины обхода (владелец, 2026-09-09).
 * `week` → 7 дней, `month` → 30, `range` → сам период, `all` → границ нет вовсе.
 * 🔴 Своего окна у шага больше нет: прежние «последние `AMESTAT_COMMENTS_DAYS` дней»
 * независимо от глубины означали, что обход за месяц приносил счётчики месячных видео, а
 * тексты — только недельных, и в логе стояло «свежих с новыми комментариями нет за 7 дн.».
 * ⚠️ Границы приходят готовыми (`depthBounds` в `scope.mjs`) — считать их здесь второй раз
 * значило бы завести «месяц» дважды. Чистая функция.
 */
export function commentsWindow({ bounds = null } = {}) {
  return {
    since: bounds?.since ?? null,
    until: bounds?.until ?? null,
  };
}

/**
 * Оценка всего обхода по строкам базы. Ничего не читает и не пишет — данные приходят готовыми.
 *
 * `creators` — `[{ id, handle, platform }]` в порядке обхода;
 * `videos`   — строки `videos` этих креаторов: `{ creator_id, id, published_at, ours, watch }`;
 * `counts`   — Map «id видео → число комментариев последнего снимка» (нет строки — нет счёта);
 * `opts`     — `{ depth, bounds, videos: 'all'|'ours', maxVideos, comments, replies, allVideos,
 *                 direct }` (`direct` — включён ли прямой путь: тогда шаг комментариев TikTok
 *                 считается по единицам `comments.direct` / `replies.direct`)
 *                (окно шага комментариев — те же `bounds`, своего у него нет);
 * `timing`   — калибровка.
 *
 * Отдаёт `{ total, byCreator: [{ creatorId, handle, list, comments, replies, total, done }] }`,
 * где `total` — секунды на весь обход. Чистая функция: её проверяют тесты.
 */
export function estimateRun(creators, videos, counts, opts = {}, timing = DEFAULT_TIMING) {
  const t = normalizeTiming(timing);
  const mode = opts.videos === "ours" ? "ours" : "all";
  const depth = String(opts.depth ?? "all");
  const bounds = opts.bounds ?? { since: null, until: null };
  const win = commentsWindow({ bounds });
  const withComments = opts.comments !== false;
  const withReplies = opts.replies !== false;
  const allVideos = opts.allVideos === true;
  // Прямой путь включён — шаг комментариев TikTok считается по дешёвым единицам (`commentKeys`).
  const direct = opts.direct === true;

  const byCreator = new Map();
  for (const row of videos ?? []) {
    const key = String(row?.creator_id ?? "");
    const list = byCreator.get(key) ?? [];
    list.push(row);
    byCreator.set(key, list);
  }

  const out = [];
  let total = 0;
  for (const creator of creators ?? []) {
    const rows = byCreator.get(String(creator.id)) ?? [];
    // От новых к старым — в таком порядке ленту и листают; видео без даты считается самым
    // старым, как и в `filterDepth`.
    const sorted = [...rows].sort((a, b) => (msOf(b?.published_at) ?? -Infinity) - (msOf(a?.published_at) ?? -Infinity));
    let inDepth = 0;
    let toTracked = 0;
    let commentVideos = 0;
    sorted.forEach((row, i) => {
      const at = msOf(row?.published_at);
      const okSince = bounds.since === null || bounds.since === undefined || (at !== null && at >= bounds.since);
      const okUntil = bounds.until === null || bounds.until === undefined || (at !== null && at <= bounds.until);
      if (okSince && okUntil) inDepth++;
      if (row?.ours === true || row?.watch === true) toTracked = i + 1;
      if (withComments && commentCandidate(row, counts?.get?.(String(row?.id)) ?? counts?.[String(row?.id)], { ...win, allVideos })) {
        commentVideos++;
      }
    });
    const scrolls = listScrolls({
      platform: creator.platform,
      mode,
      depth,
      videosTotal: sorted.length,
      inDepth,
      toTracked,
      maxVideos: opts.maxVideos ?? null,
    });
    const one = estimateCreator({
      handle: creator.handle,
      platform: creator.platform,
      scrolls,
      commentVideos,
      comments: withComments,
      replies: withReplies,
      direct,
    }, t);
    out.push({ creatorId: String(creator.id), ...one, done: false });
    total += one.total;
  }
  return { total: Math.round(total * 10) / 10, byCreator: out };
}

/**
 * Сколько секунд осталось до конца обхода. Полосы идут ОДНОВРЕМЕННО, поэтому остаток считается
 * по каждой отдельно, а итог — самая долгая из них: обход кончается, когда закончит последняя.
 *
 * `lanes` — `[{ total, done, elapsedMs }]` по полосе.
 * Скорость берётся у самой полосы (`elapsedMs / done`), но только когда она прошла больше
 * десятой части своей работы: на первых секундах отношение скачет от нуля до бесконечности и
 * врало бы сильнее калибровки. До этого порога секунда работы считается секундой — единицы в
 * секундах и заведены.
 * Чистая функция.
 */
export function etaSeconds(lanes) {
  let worst = 0;
  for (const lane of lanes ?? []) {
    const total = Math.max(0, Number(lane?.total) || 0);
    const done = Math.max(0, Number(lane?.done) || 0);
    const remaining = Math.max(0, total - done);
    if (remaining === 0) continue;
    const elapsed = Math.max(0, Number(lane?.elapsedMs) || 0) / 1000;
    const rate = done > 0 && done > total * 0.1 && elapsed > 0 ? elapsed / done : 1;
    worst = Math.max(worst, remaining * rate);
  }
  return Math.round(worst);
}

/** Доля сделанного, 0–100. Оценки нет — null: полосе неоткуда взяться. Чистая функция. */
export function percentDone(done, total) {
  const all = Number(total);
  if (!Number.isFinite(all) || all <= 0) return null;
  const did = Math.max(0, Number(done) || 0);
  return Math.max(0, Math.min(100, Math.round((did / all) * 100)));
}

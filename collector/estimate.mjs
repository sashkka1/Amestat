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
//   • шаг комментариев — СТРАНИЦЫ и ВЕТКИ, а не видео (владелец, 2026-09-10: обход #107
//     `@mrbeast` обещал «меньше минуты», а видео с 7700 комментариями шло полминуты — цена
//     «за видео» была средней по креаторам, у которых под роликом 1–3 комментария). Видео стоит
//     `ceil(min(счётчик, AMESTAT_COMMENTS_MAX) / 20)` страниц × `comments.page.*` плюс
//     `min(счётчик, потолок) × replies.share` веток × `replies.branch.*`, если ветки раскрываются
//     (`videoUnits`, `commentSeconds`). Счётчик — из последнего снимка (`video_snaps.comments`).
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
//
// 🔴 Три круга оценки (владелец, 2026-09-10: «подсчёт времени врёт… хочу, чтобы оценка сначала
// узнавала объём: сколько видео, потом по ходу пересчитывала»):
//   1. ПРЕДВАРИТЕЛЬНАЯ — до браузера, по базе. Креатора, о котором в базе нет ни одного видео,
//      база оценить не может вовсе: только что добавленный крупный аккаунт давал вклад около
//      нуля, и весь обход выглядел коротким. Такой креатор считается по МЕДИАНЕ числа видео
//      среди известных креаторов его площадки (нет никого — `ASSUMED_VIDEOS`), а вся оценка
//      помечается `rough: true`: сайт при ней не рисует полосу процентов вовсе.
//   2. ПОСЛЕ ШАГА СПИСКА — `reviseAfterList`: предположение заменяется фактом (сколько секунд
//      занял список и сколько видео возьмёт шаг комментариев по правилу `pickComments`).
//      Пересчёт идёт по КАЖДОМУ креатору, а не только по первому.
//   3. ПО ФАКТИЧЕСКОМУ ТЕМПУ — `livePrices`: набралось не меньше `PACE_MIN_SAMPLES` замеров
//      этого обхода, и цены единиц берутся их МЕДИАНОЙ (`paceFrom`), а не калибровкой из файла.
//      Калибровка остаётся тем, чем и была: первой оценкой, пока замеров ещё нет. Доля веток
//      (`replies.share`) — исключение: она пересчитывается после ПЕРВОГО же видео, суммой
//      «веток / корней» по всем видео этого обхода.
//
// 🔴 Остаток считается из ОСТАВШИХСЯ ЕДИНИЦ (`remainingOf`: прокрутки, страницы, ветки
// непройденных видео и креаторов) по живым ценам, а не как «оценка − сделано»: при перерасходе
// разность схлопывалась в ноль, и обход #107 при 285 сделанных из 245 оценённых показывал «почти
// готово». `sync.mjs` пишет `work_total = work_done + остаток` — объём растёт вместе с ценами.

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
  // Шаг комментариев — ЗА СТРАНИЦУ и ЗА ВЕТКУ, а не за видео (2026-09-10). Прежние
  // `comments.video` / `replies.video` / `comments.direct` / `replies.direct` были ценой видео и
  // из старого файла просто отбрасываются: перевести их в новые единицы не во что.
  // ⚠️ Страница здесь — страница ОЦЕНКИ (`videoUnits`: 20 комментариев из счётчика), а не запрос
  // к TikTok: у `@mrbeast` сотня корней пришла за 7–16 запросов, а оценка считает её пятью
  // страницами. Поэтому и замеряется цена в тех же единицах — секунды корней ÷ страницы оценки,
  // и живая цена сама вбирает разницу.
  // Прямой путь: по журналу обхода #107 запрос страницы с паузой `AMESTAT_DIRECT_PAUSE_MS` —
  // 0,85 с (9 страниц за 7,7 с), запрос ветки — столько же.
  "comments.page.direct": 0.8,
  "replies.branch.direct": 0.9,
  // Браузер — откат прямого пути; числа с глаз по прежней калибровке (≈15 с на маленькое видео).
  "comments.page.browser": 15,
  "replies.branch.browser": 10,
  // ДОЛЯ корней, под которыми раскрывается ветка (0–1), — не секунды. У `@mrbeast` под сотней
  // корней набиралось ≈30 веток.
  "replies.share": 0.3,
};

export const TIMING_KEYS = Object.keys(DEFAULT_TIMING);

/** Ключи-доли: 0–1, ноль законен (веток не было вовсе), в файле — до сотых. */
const SHARE_KEYS = new Set(["replies.share"]);

/**
 * Сколько комментариев в одной странице ОЦЕНКИ — столько же, сколько `DIRECT_PAGE` в
 * `direct.mjs` просит у TikTok (`count=20`). Своя копия, чтобы оценка не тянула за собой сеть;
 * равенство держит тест в `direct.test.mjs`.
 */
export const COMMENTS_PAGE = 20;

/** Потолок корневых на видео, если его не передали, — умолчание `AMESTAT_COMMENTS_MAX`. */
export const DEFAULT_COMMENTS_MAX = 100;

/**
 * Сколько комментариев предположить у видео, чей счётчик неизвестен (креатор, о котором база
 * не знает ничего): одна полная страница. Больше — оценка новичка раздулась бы на порядок,
 * меньше — вернулось бы «меньше минуты».
 */
export const ASSUMED_COMMENTS = 20;

/**
 * Сколько видео приходит за одну прокрутку списка. У TikTok страница ответа — 20 роликов,
 * у Instagram — 12. Числа нужны только оценке: сама прокрутка идёт до конца списка, а не по
 * счётчику.
 */
export const PER_SCROLL = { tiktok: 20, instagram: 12 };

/**
 * Сколько видео предположить у креатора, о котором в базе нет НИ ОДНОГО видео, если и медиану
 * взять не у кого (первый креатор площадки). Числа с глаз и нарочно крупные: занижение здесь
 * стоит дороже завышения — оно и было причиной «меньше минуты» на аккаунте, идущем полчаса.
 */
export const ASSUMED_VIDEOS = { tiktok: 100, instagram: 200 };

/** Меньше стольких замеров медиане верить рано: один-два выброса сдвинут её куда угодно. */
export const PACE_MIN_SAMPLES = 3;

/**
 * Какой парой единиц считается шаг комментариев: прямым запросом или браузером.
 * Одно место на весь модуль и на `sync.mjs` — иначе оценка считала бы одними ключами, а
 * калибровка правила бы другие, и полоса прогресса разъехалась бы молча. Чистая функция.
 */
export function commentKeys(direct = false) {
  return direct === true
    ? { page: "comments.page.direct", branch: "replies.branch.direct" }
    : { page: "comments.page.browser", branch: "replies.branch.browser" };
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
  for (const key of TIMING_KEYS) {
    out[key] = (SHARE_KEYS.has(key) ? share(raw?.[key]) : num(raw?.[key])) ?? DEFAULT_TIMING[key];
  }
  return out;
}

/** Доля 0–1; мусор и пусто — null. Ноль законен: у видео могло не быть ни одной ветки. */
function share(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : null;
}

/**
 * Единицы шага комментариев у ОДНОГО видео: `{ pages, roots }`.
 *   • `roots` — сколько корневых возьмёт шаг: счётчик площадки, срезанный потолком `max`
 *     (`AMESTAT_COMMENTS_MAX`). Счётчик считает и ответы, так что это оценка сверху;
 *   • `pages` — страницы оценки по `COMMENTS_PAGE`, не меньше одной.
 * Счётчик неизвестен (у видео нет снимка) — `ASSUMED_COMMENTS`. Чистая функция.
 */
export function videoUnits(comments, max = DEFAULT_COMMENTS_MAX) {
  const c = Number(comments);
  const n = Number.isFinite(c) && c > 0 ? c : ASSUMED_COMMENTS;
  const cap = num(max) ?? DEFAULT_COMMENTS_MAX;
  const roots = Math.min(n, cap);
  return { pages: Math.max(1, Math.ceil(roots / COMMENTS_PAGE)), roots };
}

/**
 * Единицы шага комментариев у набора видео: `{ videos, pages, roots }` — сумма `videoUnits`.
 * `counts` — счётчики комментариев этих видео. Чистая функция.
 */
export function commentUnits(counts, max = DEFAULT_COMMENTS_MAX) {
  let videos = 0, pages = 0, roots = 0;
  for (const c of counts ?? []) {
    const one = videoUnits(c, max);
    videos++;
    pages += one.pages;
    roots += one.roots;
  }
  return { videos, pages, roots };
}

/**
 * Секунды шага комментариев по единицам: `{ comments, replies }`.
 * `comments` — страницы × цена страницы, `replies` — корни × доля веток × цена ветки (ноль,
 * если ветки не раскрываются). Чистая функция.
 */
export function commentSeconds({ pages = 0, roots = 0 } = {}, timing = DEFAULT_TIMING, { direct = false, replies = true } = {}) {
  const t = normalizeTiming(timing);
  const keys = commentKeys(direct);
  const p = Math.max(0, Number(pages) || 0);
  const r = Math.max(0, Number(roots) || 0);
  return {
    comments: p * t[keys.page],
    replies: replies === false ? 0 : r * t["replies.share"] * t[keys.branch],
  };
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
 * Калибровка после шага комментариев. `m` — замер шага в единицах оценки:
 *   • `pages`, `roots` — сумма `videoUnits` по видео, которые шаг обошёл этим путём;
 *   • прямой путь знает, где кончились корни и начались ветки, и отдаёт их порознь:
 *     `pageSeconds` (корни), `branchSeconds` и `branches` (сколько веток запрошено). Тогда каждая
 *     цена двигается своим замером, а доля веток — отношением `branches / roots`;
 *   • браузер знает только всё время шага (`seconds`) — оно накрывает обе цены разом, и они
 *     двигаются одним множителем, как база и прокрутка в `calibrateList`.
 * `replies: false` — ветки не раскрывались: цена ветки и доля не трогаются, всё время идёт в
 * страницы.
 * Пути два и цены у них разные на порядок, поэтому и калибруются они порознь: замер прямого
 * пути не имеет права утянуть вниз цену браузерного, и наоборот (`commentKeys`). Чистая функция.
 */
export function calibrateComments(timing, m = {}, { direct = false, replies = true, alpha = TIMING_ALPHA } = {}) {
  const t = normalizeTiming(timing);
  const pages = Math.max(0, Number(m?.pages) || 0);
  if (pages === 0) return t;
  const roots = Math.max(0, Number(m?.roots) || 0);
  const a = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : TIMING_ALPHA;
  const { page, branch } = commentKeys(direct);
  const out = { ...t };

  const pageSeconds = num(m?.pageSeconds);
  if (pageSeconds !== null) {
    out[page] = foldEma(t[page], pageSeconds / pages, a);
    if (replies !== false) {
      const branches = Math.max(0, Math.round(Number(m?.branches) || 0));
      const branchSeconds = num(m?.branchSeconds);
      if (branches > 0 && branchSeconds !== null) out[branch] = foldEma(t[branch], branchSeconds / branches, a);
      // Ноль веток — тоже замер: доля честно идёт вниз, `foldEma` ноль бы отбросил.
      if (roots > 0) out["replies.share"] = t["replies.share"] * (1 - a) + Math.min(1, branches / roots) * a;
    }
    return out;
  }

  const spent = num(m?.seconds);
  if (spent === null) return t;
  if (replies === false) return { ...out, [page]: foldEma(t[page], spent / pages, a) };
  const predicted = pages * t[page] + roots * t["replies.share"] * t[branch];
  if (!(predicted > 0)) return t;
  const scale = spent / predicted;
  out[page] = foldEma(t[page], t[page] * scale, a);
  out[branch] = foldEma(t[branch], t[branch] * scale, a);
  return out;
}

/**
 * Медиана списка чисел. Пусто и сплошной мусор — `null`.
 * 🔴 Именно медиана, а не среднее: одно видео, провисевшее минуту на неудачном запросе, среднее
 * утягивает вдвое, а медиану не двигает вовсе. Чистая функция.
 */
export function medianOf(values) {
  const list = [];
  for (const v of values ?? []) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) list.push(n);
  }
  if (list.length === 0) return null;
  list.sort((a, b) => a - b);
  const mid = list.length >> 1;
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * Фактический темп по замерам ЭТОГО обхода: медиана, когда замеров набралось не меньше `min`,
 * и `fallback` (цена из калибровки), пока не набралось.
 * Чистая функция: её проверяют тесты.
 */
export function paceFrom(samples, fallback = null, min = PACE_MIN_SAMPLES) {
  const list = [];
  for (const v of samples ?? []) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) list.push(n);
  }
  const need = Number.isFinite(min) && min > 0 ? min : PACE_MIN_SAMPLES;
  if (list.length < need) return fallback;
  return medianOf(list);
}

/**
 * Цены единиц по фактическому темпу обхода — та же форма, что у калибровки, и на её место.
 * `samples` — замеры ЭТОГО обхода:
 *   • `scroll` — секунды на одну прокрутку списка;
 *   • `page`   — прямой путь: секунды корней видео ÷ его страницы оценки (`videoUnits`);
 *   • `branch` — прямой путь: секунды веток видео ÷ число запрошенных веток;
 *   • `share`  — прямой путь: `{ branches, roots }` по видео. 🔴 Доля веток берётся СУММОЙ
 *     «веток / корней» по всем видео обхода и уже после ПЕРВОГО видео, а не медианой после
 *     трёх: от неё зависит больше половины цены крупного видео, и калибровка по маленьким
 *     креаторам здесь врёт сильнее всего;
 *   • `browser` — браузерный путь: `{ seconds, pages, roots }` по видео. Браузер не знает, где
 *     кончились корни, поэтому из замера берётся МНОЖИТЕЛЬ «факт / предсказание» (медиана), и
 *     обе браузерные цены двигаются им, как в `calibrateComments`.
 * Замеров меньше `min` по ведру — цена этого ведра остаётся калибровочной. `replies: false` —
 * ветки не раскрываются, и их цена с долей не трогаются. Чистая функция.
 */
export function livePrices(timing, samples = {}, { platform = "tiktok", replies = true, min = PACE_MIN_SAMPLES } = {}) {
  const t = normalizeTiming(timing);
  const out = { ...t };
  const plat = platformOf(platform);
  const withReplies = replies !== false;
  const scroll = paceFrom(samples?.scroll, null, min);
  if (scroll !== null) out[`page.${plat}`] = scroll;

  const direct = commentKeys(true);
  const page = paceFrom(samples?.page, null, min);
  if (page !== null) out[direct.page] = page;
  if (withReplies) {
    const branch = paceFrom(samples?.branch, null, min);
    if (branch !== null) out[direct.branch] = branch;
    let branches = 0, roots = 0;
    for (const s of samples?.share ?? []) {
      const r = Number(s?.roots), b = Number(s?.branches);
      if (!(Number.isFinite(r) && r > 0) || !(Number.isFinite(b) && b >= 0)) continue;
      roots += r;
      branches += Math.min(b, r);
    }
    if (roots > 0) out["replies.share"] = branches / roots;
  }

  const browser = commentKeys(false);
  const scales = [];
  for (const s of samples?.browser ?? []) {
    const spent = num(s?.seconds);
    const pages = Math.max(0, Number(s?.pages) || 0);
    if (spent === null || pages === 0) continue;
    const roots = Math.max(0, Number(s?.roots) || 0);
    const predicted = pages * t[browser.page] + (withReplies ? roots * out["replies.share"] * t[browser.branch] : 0);
    if (predicted > 0) scales.push(spent / predicted);
  }
  const scale = paceFrom(scales, null, min);
  if (scale !== null) {
    out[browser.page] = t[browser.page] * scale;
    if (withReplies) out[browser.branch] = t[browser.branch] * scale;
  }
  return out;
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
 * Калибровка в файл, округлённая до сотых: читать её будет человек.
 * Не записалась — работу не валим: следующий обход просто посчитает по прежним числам.
 */
export function writeTiming(timing, file = TIMING_FILE) {
  try {
    const t = normalizeTiming(timing);
    const out = {};
    // До сотых, а не десятых: цена страницы прямого пути — доли секунды, а доля веток 0,28
    // против 0,3 на крупном креаторе — это секунды на каждом видео.
    for (const key of TIMING_KEYS) out[key] = Math.round(t[key] * 100) / 100;
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
 * Оценка одного креатора в секундах: `{ handle, list, comments, replies, total, scrolls,
 * commentPages, commentRoots }`.
 * `scrolls` — из `listScrolls`, `commentVideos` — сколько видео возьмёт шаг комментариев,
 * `commentPages` / `commentRoots` — их единицы (`commentUnits`). Единиц не дали — каждое видео
 * считается видео с неизвестным счётчиком (`videoUnits(null)`).
 * Единицы уходят в строку оценки: по ним `remainingOf` считает остаток живыми ценами.
 * Чистая функция.
 */
export function estimateCreator({
  handle = "",
  platform = "tiktok",
  scrolls = 1,
  commentVideos = 0,
  commentPages = null,
  commentRoots = null,
  comments = true,
  replies = true,
  direct = false,
} = {}, timing = DEFAULT_TIMING) {
  const t = normalizeTiming(timing);
  const plat = platformOf(platform);
  const pages = Math.max(1, Math.round(Number(scrolls) || 1));
  const videos = comments ? Math.max(0, Math.round(Number(commentVideos) || 0)) : 0;
  const unknown = videoUnits(null);
  const cPages = !comments ? 0 : commentPages !== null ? Math.max(0, Number(commentPages) || 0) : videos * unknown.pages;
  const cRoots = !comments ? 0 : commentRoots !== null ? Math.max(0, Number(commentRoots) || 0) : videos * unknown.roots;
  const list = t[`list.${plat}`] + pages * t[`page.${plat}`];
  // Прямой путь есть только у TikTok: у Instagram комментарии по-прежнему целиком браузерные.
  const secs = commentSeconds({ pages: cPages, roots: cRoots }, t, { direct: direct === true && plat === "tiktok", replies });
  const round = (n) => Math.round(n * 10) / 10;
  return {
    handle,
    list: round(list),
    comments: round(secs.comments),
    replies: round(secs.replies),
    total: round(list + secs.comments + secs.replies),
    scrolls: pages,
    commentPages: cPages,
    commentRoots: cRoots,
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
 * Сколько видео предположить у креатора, о котором база не знает ничего: МЕДИАНА числа видео
 * среди известных креаторов той же площадки. Известных нет вовсе — `ASSUMED_VIDEOS`.
 * `counts` — числа видео известных креаторов этой площадки. Чистая функция.
 */
export function assumedVideos(platform, counts = []) {
  const plat = platformOf(platform);
  const median = medianOf(counts);
  return median === null ? ASSUMED_VIDEOS[plat] : Math.max(1, Math.round(median));
}

/**
 * Пересчёт оценки одного креатора ПО ФАКТУ (владелец, 2026-09-10). Зовётся дважды:
 *   • как только шаг списка кончился — тогда `listSeconds` это его настоящая длительность, а
 *     `commentVideos` — сколько видео возьмёт шаг комментариев по правилу `pickComments`;
 *   • в начале шага комментариев — там уже известно, у скольких видео счётчик не изменился,
 *     и `listSeconds` не передаётся вовсе: список давно посчитан по факту.
 * `counts` — счётчики комментариев этих видео (`video.comments` из списка): из них считаются
 * страницы и корни (`commentUnits`). Не дали — каждое видео считается видео с неизвестным
 * счётчиком.
 * Отдаёт строку той же формы, но с `rough: false`: предположения в ней больше нет. Длительность
 * списка передана — список помечается пройденным (`listDone`): его остаток больше не считается.
 * ⚠️ `timing` сюда приходит ЖИВЫМ (`livePrices`), а не файловым — иначе остаток считался бы по
 * калибровке даже там, где обход уже показал свой темп. Чистая функция.
 */
export function reviseAfterList(prev, {
  platform = "tiktok",
  listSeconds = null,
  commentVideos = 0,
  counts = null,
  commentsMax = DEFAULT_COMMENTS_MAX,
  comments = true,
  replies = true,
  direct = false,
} = {}, timing = DEFAULT_TIMING) {
  const t = normalizeTiming(timing);
  const plat = platformOf(platform);
  const spent = num(listSeconds);
  const list = spent ?? (Number(prev?.list) > 0 ? Number(prev.list) : 0);
  let units = { videos: 0, pages: 0, roots: 0 };
  if (comments !== false) {
    if (Array.isArray(counts)) units = commentUnits(counts, commentsMax);
    else {
      const videos = Math.max(0, Math.round(Number(commentVideos) || 0));
      const one = videoUnits(null, commentsMax);
      units = { videos, pages: videos * one.pages, roots: videos * one.roots };
    }
  }
  // Прямой путь есть только у TikTok — та же развилка, что в `estimateCreator`.
  const secs = commentSeconds(units, t, { direct: direct === true && plat === "tiktok", replies });
  const round = (n) => Math.round(n * 10) / 10;
  return {
    ...prev,
    list: round(list),
    comments: round(secs.comments),
    replies: round(secs.replies),
    total: round(list + secs.comments + secs.replies),
    commentVideos: units.videos,
    commentPages: units.pages,
    commentRoots: units.roots,
    ...(spent !== null ? { listDone: true } : {}),
    rough: false,
  };
}

/**
 * Оценка всего обхода по строкам базы. Ничего не читает и не пишет — данные приходят готовыми.
 *
 * `creators` — `[{ id, handle, platform }]` в порядке обхода;
 * `videos`   — строки `videos` этих креаторов: `{ creator_id, id, published_at, ours, watch }`;
 * `counts`   — Map «id видео → число комментариев последнего снимка» (нет строки — нет счёта);
 * `opts`     — `{ depth, bounds, videos: 'all'|'ours', maxVideos, comments, replies, allVideos,
 *                 direct, commentsMax, profileVideos }` (`direct` — включён ли прямой путь: тогда
 *                 шаг комментариев TikTok считается по единицам `*.direct`; `commentsMax` —
 *                 `AMESTAT_COMMENTS_MAX`; `profileVideos` — Map «id креатора → число видео по
 *                 профилю площадки», для тех, о ком база не знает ничего)
 *                (окно шага комментариев — те же `bounds`, своего у него нет);
 * `timing`   — калибровка.
 *
 * Отдаёт `{ total, rough, byCreator: [{ creatorId, handle, list, comments, replies, total,
 * scrolls, commentVideos, commentPages, commentRoots, done, rough }] }`, где `total` — секунды
 * на весь обход.
 *
 * 🔴 `rough` — «предварительная»: у креатора нет в базе ни одного видео, и его объём ВЗЯТ ИЗ
 * ГОЛОВЫ. Так выглядит только что добавленный аккаунт: до этой пометки он давал в оценку почти
 * ноль, и обход крупного креатора обещал «меньше минуты». Число его видео берётся из профиля
 * площадки (`profileVideos`, у TikTok оно известно до прокрутки), а нет его — медианой площадки;
 * пометка остаётся в обоих случаях: счётчиков комментариев его видео не знает никто. Пока хоть
 * один креатор предварительный, предварительна вся оценка — сайт при ней не рисует полосу
 * процентов. Чистая функция: её проверяют тесты.
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
  const commentsMax = num(opts.commentsMax) ?? DEFAULT_COMMENTS_MAX;
  const countOf = (id) => counts?.get?.(String(id)) ?? counts?.[String(id)];
  const fromProfile = (id) => {
    const n = Number(opts.profileVideos?.get?.(String(id)) ?? opts.profileVideos?.[String(id)]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  const byCreator = new Map();
  for (const row of videos ?? []) {
    const key = String(row?.creator_id ?? "");
    const list = byCreator.get(key) ?? [];
    list.push(row);
    byCreator.set(key, list);
  }

  // Сколько видео база знает у каждого креатора — из этого берётся медиана площадки для тех,
  // о ком она не знает ничего.
  const knownCounts = { tiktok: [], instagram: [] };
  for (const creator of creators ?? []) {
    const n = (byCreator.get(String(creator.id)) ?? []).length;
    if (n > 0) knownCounts[platformOf(creator.platform)].push(n);
  }

  const out = [];
  let total = 0;
  let roughRun = false;
  for (const creator of creators ?? []) {
    const rows = byCreator.get(String(creator.id)) ?? [];
    const plat = platformOf(creator.platform);
    // 🔴 База не знает у креатора НИ ОДНОГО видео — считать по ней нечего. Берём число видео из
    // профиля площадки, а нет его — медиану площадки: занижение здесь и было причиной «меньше
    // минуты» на аккаунте, идущем полчаса.
    if (rows.length === 0) {
      const profiled = fromProfile(creator.id);
      const assumed = profiled ?? assumedVideos(plat, knownCounts[plat]);
      const scrolls = listScrolls({
        platform: plat,
        mode,
        depth,
        videosTotal: assumed,
        inDepth: assumed,
        // Отслеживаемых видео у него в базе нет по определению: при охвате «только наши» шаг
        // списка возьмёт одну первую страницу, и предполагать больше было бы враньём в другую
        // сторону.
        toTracked: 0,
        maxVideos: opts.maxVideos ?? null,
      });
      // Видео у него неизвестны все до одного, значит и на комментарии пойдут все, что придут:
      // «без изменений» у нового креатора не бывает. Больше, чем принесёт прокрутка, не берём.
      const cap = num(opts.maxVideos);
      let commentVideos = Math.min(assumed, scrolls * PER_SCROLL[plat]);
      if (cap !== null && mode !== "ours") commentVideos = Math.min(commentVideos, cap);
      // Счётчиков комментариев у его видео нет — каждое считается видео с неизвестным счётчиком.
      const unknown = videoUnits(null, commentsMax);
      const one = estimateCreator({
        handle: creator.handle,
        platform: plat,
        scrolls,
        commentVideos,
        commentPages: commentVideos * unknown.pages,
        commentRoots: commentVideos * unknown.roots,
        comments: withComments,
        replies: withReplies,
        direct,
      }, t);
      out.push({
        creatorId: String(creator.id),
        ...one,
        commentVideos: withComments ? commentVideos : 0,
        commentVideosDone: 0,
        done: false,
        rough: true,
        // Откуда взято число видео — строке лога «ПРЕДВАРИТЕЛЬНАЯ».
        assumedVideos: assumed,
        assumedFrom: profiled !== null ? "profile" : "median",
      });
      total += one.total;
      roughRun = true;
      continue;
    }
    // От новых к старым — в таком порядке ленту и листают; видео без даты считается самым
    // старым, как и в `filterDepth`.
    const sorted = [...rows].sort((a, b) => (msOf(b?.published_at) ?? -Infinity) - (msOf(a?.published_at) ?? -Infinity));
    let inDepth = 0;
    let toTracked = 0;
    // Счётчики комментариев кандидатов: из них — страницы и корни шага (`commentUnits`).
    const picked = [];
    sorted.forEach((row, i) => {
      const at = msOf(row?.published_at);
      const okSince = bounds.since === null || bounds.since === undefined || (at !== null && at >= bounds.since);
      const okUntil = bounds.until === null || bounds.until === undefined || (at !== null && at <= bounds.until);
      if (okSince && okUntil) inDepth++;
      if (row?.ours === true || row?.watch === true) toTracked = i + 1;
      const count = countOf(row?.id);
      if (withComments && commentCandidate(row, count, { ...win, allVideos })) picked.push(count);
    });
    const units = commentUnits(picked, commentsMax);
    const commentVideos = units.videos;
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
      commentPages: units.pages,
      commentRoots: units.roots,
      comments: withComments,
      replies: withReplies,
      direct,
    }, t);
    out.push({ creatorId: String(creator.id), ...one, commentVideos: withComments ? commentVideos : 0, commentVideosDone: 0, done: false, rough: false });
    total += one.total;
  }
  return { total: Math.round(total * 10) / 10, rough: roughRun, byCreator: out };
}

/**
 * Остаток одного креатора в секундах — из ОСТАВШИХСЯ ЕДИНИЦ по ценам `timing` (живым):
 *   • список не пройден — база + прокрутки (`scrolls`); идёт прямо сейчас — то, что ещё не
 *     засчитано (`listPaid`), но не меньше одной прокрутки: пока шаг не кончился, он не бесплатен;
 *   • комментарии — непройденные страницы и корни (`commentPages − commentPagesDone`, то же с
 *     корнями), по ценам страницы и ветки нужного пути.
 * Пройденный креатор (`done`) — ноль. Сколько секунд уже потрачено, здесь не при чём вовсе:
 * перерасход на пройденном остатка не съедает. Чистая функция.
 */
export function remainingOf(est, timing = DEFAULT_TIMING, { platform = "tiktok", direct = false, replies = true } = {}) {
  if (!est || est.done === true) return 0;
  const t = normalizeTiming(timing);
  const plat = platformOf(platform);
  let listLeft = 0;
  if (est.listDone !== true) {
    const scrolls = Math.max(1, Math.round(Number(est.scrolls) || 1));
    const planned = t[`list.${plat}`] + scrolls * t[`page.${plat}`];
    const paid = Math.max(0, Number(est.listPaid) || 0);
    listLeft = est.listRunning === true ? Math.max(t[`page.${plat}`], planned - paid) : planned;
  }
  const left = (all, done) => Math.max(0, (Number(all) || 0) - (Number(done) || 0));
  const secs = commentSeconds(
    { pages: left(est.commentPages, est.commentPagesDone), roots: left(est.commentRoots, est.commentRootsDone) },
    t,
    { direct: direct === true && plat === "tiktok", replies },
  );
  return Math.round((listLeft + secs.comments + secs.replies) * 10) / 10;
}

/**
 * Сколько секунд осталось до конца обхода. Полосы идут ОДНОВРЕМЕННО, поэтому остаток считается
 * по каждой отдельно, а итог — самая долгая из них: обход кончается, когда закончит последняя.
 *
 * `lanes` — `[{ remaining, done, elapsedMs, measured }]` по полосе.
 *   • 🔴 `remaining` — остаток полосы из ОСТАВШИХСЯ ЕДИНИЦ (`remainingOf`). Разность `total −
 *     done` при перерасходе схлопывалась в ноль, и обход, у которого впереди полчаса, показывал
 *     «почти готово». `total` понимается только там, где `remaining` не передали вовсе;
 *   • `measured: true` — у полосы набралось не меньше `PACE_MIN_SAMPLES` замеров, и её работа
 *     уже пересчитана по МЕДИАНЕ фактического темпа (`livePrices`). Тогда остаток берётся как
 *     есть: единица работы здесь и так секунда, а секунда уже настоящая, а не калибровочная;
 *   • замеров ещё нет — прежнее правило: скорость полосы `elapsedMs / done`, но только когда
 *     она прошла больше десятой части своей работы (`done + remaining`). На первых секундах
 *     отношение скачет от нуля до бесконечности и врало бы сильнее калибровки.
 * Чистая функция: её проверяют тесты.
 */
export function remainingSeconds(lanes) {
  let worst = 0;
  for (const lane of lanes ?? []) {
    const done = Math.max(0, Number(lane?.done) || 0);
    const given = lane?.remaining;
    const remaining = given !== null && given !== undefined && Number.isFinite(Number(given))
      ? Math.max(0, Number(given))
      : Math.max(0, (Number(lane?.total) || 0) - done);
    const total = done + remaining;
    if (remaining === 0) continue;
    if (lane?.measured === true) {
      worst = Math.max(worst, remaining);
      continue;
    }
    const elapsed = Math.max(0, Number(lane?.elapsedMs) || 0) / 1000;
    const rate = done > 0 && done > total * 0.1 && elapsed > 0 ? elapsed / done : 1;
    worst = Math.max(worst, remaining * rate);
  }
  return Math.round(worst);
}

/** Прежнее имя того же расчёта: полосы без замеров считаются по скорости самой полосы. */
export function etaSeconds(lanes) {
  return remainingSeconds(lanes);
}

/** Доля сделанного, 0–100. Оценки нет — null: полосе неоткуда взяться. Чистая функция. */
export function percentDone(done, total) {
  const all = Number(total);
  if (!Number.isFinite(all) || all <= 0) return null;
  const did = Math.max(0, Number(done) || 0);
  return Math.max(0, Math.min(100, Math.round((did / all) * 100)));
}

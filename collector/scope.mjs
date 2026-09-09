// Охват видео («всё» / «только наши») и ГЛУБИНА обхода. Чистые функции — их проверяет
// `scope.test.mjs`.
//
// Глубина (миграция v18; владелец, 2026-09-09: «в матрице есть 7 дней и всё время — сделаем
// ещё за месяц и за выбранный период») бывает четырёх видов:
//   • `all`   — весь список видео, как было всегда;
//   • `week`  — последние 7 дней;
//   • `month` — последние 30 дней;
//   • `range` — период между `depth_from` и `depth_to` (обе границы обязательны).
//
// 🔴 Правило отбора живёт ЗДЕСЬ и больше нигде: площадки и `sync.mjs` получают готовые границы
// от `depthBounds` и сами дат не считают. Иначе «месяц» пришлось бы завести трижды — в
// `tiktok.mjs`, `instagram-web.mjs` и `instagram-graph.mjs`, — и разошлись бы они молча.
//
// ⚠️ Границы работают по-разному, и это нарочно:
//   • `since` (нижняя) ОБРЫВАЕТ прокрутку: обе ленты идут от новых к старым, и за первым
//     видео старше границы ничего нужного уже нет;
//   • `until` (верхняя) прокрутку НЕ обрывает — самые свежие видео лежат в начале ленты, и
//     пройти сквозь них надо, — но в базу они не идут ни строкой, ни снимком.
//
// Владелец, 2026-09-09: у видео три состояния — `ours` (наше, зелёное), `watch` (не наше, но
// смотрим историю, жёлтое) и ни то ни другое (серое). В матрице обновления на сайте появился
// выбор охвата: «только наши — тогда на лишние видео не смотрим и экономим время».
//
// Что охват меняет на шаге списка:
//   • `all` — как было всегда: листаем до конца списка, а при глубине «неделя» до первого
//     видео старше недели;
//   • `ours` — листаем, пока не встретились ВСЕ отслеживаемые видео креатора (`ours` или
//     `watch`) или пока список не кончился. ⚠️ Глубина «неделя» при этом прокрутку НЕ
//     обрывает: старые наши видео иначе никогда бы не обновились, а ради них охват и заведён.
//     Верхняя граница всё же есть — `AMESTAT_OURS_MAX_PAGES` прокруток (пусто — 30): дошли до
//     неё, значит остальные отслеживаемые не нашлись, и об этом идёт строка в лог и замечание.
//   • отслеживаемых нет вовсе — при `ours` берётся только первая страница (новые видео по ней
//     всё равно заводятся) и всё.
//
// ⚠️ Всё, что пришло в пролистанной части, кладётся в базу как обычно — снимок счётчиков
// достаётся даром вместе со списком, и резать его незачем.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Момент в мс эпохи из чего угодно (Date, ISO-строка, число). Мусор и пустота — null. */
function msOf(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

/** Тот же момент строкой ISO — в таком виде границы лежат в базе и ездят между модулями. */
function isoOf(value) {
  const ms = msOf(value);
  return ms === null ? null : new Date(ms).toISOString();
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Приведение глубины к одному из четырёх видов — ОДНО на весь сборщик: так её читают и просьба
 * с сайта (`watch.mjs`), и склейка (`requests.mjs`), и `runSync`.
 * Отдаёт `{ depth, from, to, note }`, где `from`/`to` — ISO-строки (только у `range`), а `note` —
 * русская строка для лога, если глубину пришлось опустить до `all`.
 *   • незнакомое слово → `all` с замечанием;
 *   • `range` без обеих границ (или `from >= to`) → `all` с замечанием: период без краёв
 *     отобрал бы либо всё, либо ничего, и оба ответа были бы враньём;
 *   • `week` и `month` границ не имеют вовсе — они считаются от «сейчас» в `depthBounds`.
 * Чистая функция: её проверяют тесты.
 */
export function normalizeDepth(depth, from = null, to = null) {
  const kind = String(depth ?? "").trim().toLowerCase();
  if (kind === "week" || kind === "month") return { depth: kind, from: null, to: null, note: null };
  if (kind === "range") {
    const a = isoOf(from), b = isoOf(to);
    if (a === null || b === null || Date.parse(a) >= Date.parse(b)) {
      return {
        depth: "all", from: null, to: null,
        note: `глубина «период» без границ (от ${from ?? "—"} до ${to ?? "—"}) — иду по всему списку`,
      };
    }
    return { depth: "range", from: a, to: b, note: null };
  }
  if (kind !== "" && kind !== "all") {
    return { depth: "all", from: null, to: null, note: `неизвестная глубина «${depth}» — иду по всему списку` };
  }
  return { depth: "all", from: null, to: null, note: null };
}

/**
 * Границы отбора видео по глубине — ЕДИНСТВЕННОЕ место, где они считаются.
 * `depth` — 'all' | 'week' | 'month' | 'range'; `{ from, to }` — границы периода (ISO, Date или
 * мс); `now` — «сейчас» в мс (тесты подставляют своё).
 * Отдаёт `{ since, until }` в мс эпохи, где null — «границы нет»:
 *   • `all`   → `{ null, null }`;
 *   • `week`  → `{ now − 7 дн., null }`;
 *   • `month` → `{ now − 30 дн., null }`;
 *   • `range` → `{ from, to }` (перепутанные местами границы разворачиваются).
 * ⚠️ `range` без разбираемых границ отдаёт нули, а не пустоту: пришедшая сюда кривая просьба
 * должна собрать всё, а не молча ничего. Отсечь её раньше — дело `normalizeDepth`.
 * Чистая функция: её проверяют тесты.
 */
export function depthBounds(depth, { from = null, to = null } = {}, now = Date.now()) {
  const kind = String(depth ?? "all").trim().toLowerCase();
  const at = msOf(now) ?? Date.now();
  if (kind === "week") return { since: at - WEEK_MS, until: null };
  if (kind === "month") return { since: at - MONTH_MS, until: null };
  if (kind === "range") {
    const a = msOf(from), b = msOf(to);
    if (a === null || b === null) return { since: null, until: null };
    return { since: Math.min(a, b), until: Math.max(a, b) };
  }
  return { since: null, until: null };
}

/**
 * Слово глубины без дат — то, что стоит в строках лога вида «за месяц: 3 из 12 пришедших».
 * Чистая функция.
 */
export function depthWord(depth) {
  const kind = String(depth ?? "all").trim().toLowerCase();
  if (kind === "week") return "неделя";
  if (kind === "month") return "месяц";
  if (kind === "range") return "период";
  return "всё";
}

/**
 * Глубина словом для человека — шапка обхода в логе, письмо владельцу, строка просьбы у
 * резидента. У периода к слову добавляются края: «период 01.09–09.09».
 * 🔴 Одна на весь сборщик: раньше каждый модуль писал свой тернарник «week ? неделя : всё», и
 * четвёртое значение пришлось бы вписывать в четыре места. Чистая функция.
 */
export function depthLabel(depth, from = null, to = null) {
  const word = depthWord(depth);
  if (word !== "период") return word;
  const a = msOf(from), b = msOf(to);
  if (a === null || b === null) return word;
  const day = (ms) => {
    const d = new Date(ms);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  };
  return `${word} ${day(Math.min(a, b))}–${day(Math.max(a, b))}`;
}

/**
 * Период из двух дат командной строки (`--from 2026-09-01 --to 2026-09-09`).
 * Даты МЕСТНЫЕ и берутся целыми сутками: `from` — начало своего дня, `to` — конец своего
 * (23:59:59.999). Иначе «с 1 по 9» теряло бы девятое число целиком.
 * Полный момент времени (`2026-09-01T12:00`) тоже понимается и берётся как есть.
 * Отдаёт `{ from, to }` ISO-строками или null, если разобрать не вышло или края перепутаны.
 * Чистая функция: её проверяют тесты.
 */
export function dayRange(fromText, toText) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const edge = (text, end) => {
    const raw = String(text ?? "").trim();
    if (raw === "") return null;
    if (!dateOnly.test(raw)) return msOf(raw);
    const [y, m, d] = raw.split("-").map(Number);
    return end
      ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
      : new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  };
  const from = edge(fromText, false);
  const to = edge(toText, true);
  if (from === null || to === null || from >= to) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Множество строковых id из чего угодно (массив, Set, Map-ключи). */
function idSet(ids) {
  const out = new Set();
  for (const id of ids ?? []) {
    if (id === null || id === undefined) continue;
    out.add(String(id));
  }
  return out;
}

/**
 * Каких отслеживаемых видео ещё не встретилось в пришедшей части списка.
 * Отдаёт массив id в порядке `trackedIds`. Чистая функция.
 */
export function missingTracked(trackedIds, seenIds) {
  const seen = idSet(seenIds);
  const out = [];
  for (const id of idSet(trackedIds)) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Пора ли перестать листать список.
 * `mode` — 'all' или 'ours'; `trackedIds` — id наших и жёлтых видео креатора; `seenIds` — id
 * всего, что уже пришло; `reachedOld` — в пачке было видео старше границы недели;
 * `hasMore` — площадка сказала, что список ещё не кончился.
 * Отдаёт `{ stop, reason }`, где `reason` — 'end' (список кончился), 'old' (пошли видео старше
 * недели), 'tracked' (все отслеживаемые нашлись), 'no-tracked' (при 'ours' отслеживаемых нет
 * вовсе — хватит первой страницы) или null, если листать дальше.
 * Чистая функция: её проверяют тесты.
 */
export function listStop({ mode = "all", trackedIds = [], seenIds = [], reachedOld = false, hasMore = true } = {}) {
  if (mode === "ours") {
    // ⚠️ «Все отслеживаемые нашлись» проверяется ПЕРЕД концом списка: причина остановки для
    // лога тогда честнее — мы не долистали до дна, а нашли всё, за чем шли.
    const tracked = idSet(trackedIds);
    if (tracked.size === 0) return { stop: true, reason: "no-tracked" };
    if (missingTracked(trackedIds, seenIds).length === 0) return { stop: true, reason: "tracked" };
    if (!hasMore) return { stop: true, reason: "end" };
    // Глубина «неделя» здесь не при чём: за старыми нашими мы как раз и листаем.
    return { stop: false, reason: null };
  }
  if (!hasMore) return { stop: true, reason: "end" };
  if (reachedOld) return { stop: true, reason: "old" };
  return { stop: false, reason: null };
}

/**
 * Потолок прокруток для этого охвата: у 'ours' свой (`AMESTAT_OURS_MAX_PAGES`), у 'all'
 * прежний потолок площадки. Чистая функция.
 */
export function listRounds(mode, oursMaxPages, defaultRounds) {
  if (mode !== "ours") return defaultRounds;
  const n = Number(oursMaxPages);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : defaultRounds;
}

/**
 * Отбор по глубине: `since` и `until` — границы в мс эпохи (null — границы нет).
 * ⚠️ Нижнюю границу отслеживаемые видео (наши и жёлтые) переживают ВСЕГДА, даже если они
 * сильно старше: ради них охват 'ours' и листает глубже, и выбрасывать их на последнем шаге
 * было бы бессмыслицей. При охвате 'all' `trackedIds` пуст, и правило работает как раньше.
 * ⚠️ А вот верхнюю границу не переживает никто: «за выбранный период» значит период, и видео
 * свежее `until` не идёт ни в `videos`, ни в снимок — даже наше. Иначе просьба «покажи первую
 * неделю сентября» тихо приносила бы вчерашние цифры.
 * Чистая функция.
 */
export function filterDepth(videos, since, trackedIds = [], until = null) {
  const hasSince = since !== null && since !== undefined;
  const hasUntil = until !== null && until !== undefined;
  if (!hasSince && !hasUntil) return [...(videos ?? [])];
  const tracked = idSet(trackedIds);
  return (videos ?? []).filter((v) => {
    const at = v.publishedAt === null || v.publishedAt === undefined ? null : Date.parse(v.publishedAt);
    const known = at !== null && !Number.isNaN(at);
    // Верхняя граница первой: она сильнее пометки «наше». Дата неизвестна — в период не берём:
    // положить видео неизвестной давности в срез за конкретные дни нельзя.
    if (hasUntil && (!known || at > until)) return false;
    if (tracked.has(String(v.id))) return true;
    return hasSince ? known && at >= since : true;
  });
}

// Охват видео: «всё» или «только наши». Чистые функции — их проверяет `scope.test.mjs`.
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
 * Отбор по глубине: `since` — граница в мс эпохи (null — глубина «всё», берём всё).
 * ⚠️ Отслеживаемые видео (наши и жёлтые) остаются ВСЕГДА, даже если они старше недели: ради
 * них охват 'ours' и листает глубже, и выбрасывать их на последнем шаге было бы бессмыслицей.
 * При охвате 'all' `trackedIds` пуст, и правило работает ровно как раньше. Чистая функция.
 */
export function filterDepth(videos, since, trackedIds = []) {
  if (since === null || since === undefined) return [...(videos ?? [])];
  const tracked = idSet(trackedIds);
  return (videos ?? []).filter((v) => {
    if (tracked.has(String(v.id))) return true;
    return v.publishedAt !== null && v.publishedAt !== undefined && Date.parse(v.publishedAt) >= since;
  });
}

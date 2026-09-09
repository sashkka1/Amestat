// Просьбы с сайта → обходы: чистая склейка, без базы и без таймеров.
//
// Жила в `watch.mjs`, но резидент при импорте поднимает часы, Realtime и опрос — тестам такое
// не подсунешь. Здесь только расчёт; резидент его зовёт, тесты проверяют (`requests.test.mjs`).
//
// Правило склейки: ключ группы — пара «охват × глубина», а обход, который делает больше,
// забирает просьбы того, кто делает меньше. Смысл один: не гонять браузер к одному креатору
// дважды подряд — TikTok от этого отвечает пустотой.
//
// ⚠️ Галочки «снимать комментарии» и «снимать ветки ответов» ключом группы НЕ являются: они
// складываются по «или» — `true` поглощает `false` того же охвата и глубины. Иначе просьба
// «всё, с комментариями» и просьба «всё, без комментариев» дали бы два обхода подряд, а
// человек, попросивший комментарии, всё равно должен их получить.
//
// ⚠️ Так же складывается и охват видео (`videos`, миграция v17): хоть одна просьба «всё» —
// обход идёт по всему списку, и просьба «только наши» получает больше, чем просила. Обратное
// было бы потерей: попросивший полный список остался бы без чужих видео.
//
// ⚠️ Глубина (миграция v18) в ключ группы входит ВМЕСТЕ С ГРАНИЦАМИ: два разных периода — две
// разные просьбы, и склеить их нечем. Иначе «с 1 по 5» и «с 10 по 20» слились бы в один обход,
// который не отдал бы правильно ни того ни другого.

// ⚠️ Потолок числа видео (`max_videos`, миграция v19) ключом группы тоже НЕ является: он
// складывается как охват — берётся тот, что делает больше. `null` («без потолка») побеждает любое
// число, из двух чисел побеждает большее. Иначе просьба «до 50 видео» отняла бы у соседней
// просьбы «всё» те видео, за которыми та и шла.

import { normalizeDepth, videoCap, widerCap } from "./scope.mjs";

/** Насколько глубина «широка»: чем больше, тем больше чужих просьб она может забрать. */
const DEPTH_RANK = { all: 3, month: 2, week: 1, range: 0 };

/**
 * Покрывает ли глубина `big` глубину `small`.
 *   • `all` покрывает всё;
 *   • `month` покрывает `week` и себя: 30 дней включают 7;
 *   • `week` покрывает только `week`;
 *   • `range` покрывает ТОЛЬКО ровно такой же период. Даже период пошире не берёт чужой
 *     поуже: у него своя верхняя граница, и чужие свежие видео он отсечёт.
 * Чистая функция: её проверяют тесты.
 */
function depthCovers(big, small) {
  if (big.depth === "all") return true;
  if (big.depth === "range" || small.depth === "range") {
    return big.depth === "range" && small.depth === "range"
      && big.depthFrom === small.depthFrom && big.depthTo === small.depthTo;
  }
  return (DEPTH_RANK[big.depth] ?? 0) >= (DEPTH_RANK[small.depth] ?? 0);
}

/** Покрывает ли обход группы `big` просьбы группы `small`: охват шире или тот же, глубина не мельче. */
export function covers(big, small) {
  const scopeOk = big.creatorId === null || big.creatorId === small.creatorId;
  return scopeOk && depthCovers(big, small);
}

/**
 * Просьбы одной пачки → обходы. Группы, целиком покрытые другой группой, отдают ей свои id
 * и своего обхода не получают.
 * ⚠️ «Все креаторы, неделя» НЕ покрывает «этот креатор, всё»: глубина мельче, и просьба
 * человека про полный список осталась бы невыполненной.
 * Отдаёт `[{ creatorId, depth, depthFrom, depthTo, videos, maxVideos, comments, replies, allVideos, requestedBy, ids }]`.
 * `maxVideos` — потолок числа видео (v19): `null` («без потолка») от любой просьбы побеждает,
 * из двух чисел остаётся большее.
 * `depth` — 'all' | 'week' | 'month' | 'range' (v18); у `range` заполнены `depthFrom`/`depthTo`,
 * у остальных они null. Кривая глубина опускается до 'all' (`normalizeDepth` в `scope.mjs`) —
 * резидент про это уже сказал в лог, когда клал просьбу в очередь.
 * `allVideos` склеивается по «или» так же: хоть одна просьба «и не наши видео» — обход снимает у всех.
 * `videos` — охват списка: хоть одна просьба `'all'` (в том числе просьба без поля вовсе) —
 * обход идёт по всему списку; «только наши» получается лишь тогда, когда его просили все.
 */
export function groupRequests(rows) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const creatorId = r.creator_id ?? null;
    // ⚠️ Границы читаются в обоих написаниях: прямо из базы (`depth_from`) и из очереди
    // резидента, где просьба уже разобрана (`depthFrom`). Та же беда, что была с `all_videos`.
    const { depth, from, to } = normalizeDepth(r.depth, r.depth_from ?? r.depthFrom ?? null, r.depth_to ?? r.depthTo ?? null);
    const key = `${creatorId ?? "все"}|${depth}|${from ?? ""}|${to ?? ""}`;
    const fresh = !groups.has(key);
    const g = groups.get(key) ?? { creatorId, depth, depthFrom: from, depthTo: to, requestedBy: r.requested_by ?? null, videos: "ours", maxVideos: null, comments: false, replies: false, allVideos: false, ids: [] };
    g.ids.push(r.id);
    // Потолок (v19): у первой просьбы группы берётся как есть, дальше побеждает тот, что шире.
    // ⚠️ Оба написания, как и у прочих полей: прямо из базы (`max_videos`) и из очереди
    // резидента, где просьба уже разобрана (`maxVideos`).
    const cap = videoCap(r.max_videos ?? r.maxVideos);
    g.maxVideos = fresh ? cap : widerCap(g.maxVideos, cap);
    // Нет поля вовсе (старая просьба, обрезанный select) — считаем «да», как было до флагов.
    g.comments = g.comments || r.comments !== false;
    g.replies = g.replies || r.replies !== false;
    // Этот флаг `default false`: нет поля — только наши, как всегда.
    // ⚠️ Понимаются оба написания: строка приходит либо прямо из базы (`all_videos`), либо из
    // очереди резидента, где она уже разобрана (`allVideos`). Резидент клал только второе, и
    // галочка «и не наши видео» с сайта до обхода не доезжала вовсе.
    g.allVideos = g.allVideos || r.all_videos === true || r.allVideos === true;
    // Охват по «или»: `'all'` поглощает `'ours'`. Нет поля — считаем `'all'`, как было до v17.
    g.videos = g.videos === "all" || r.videos !== "ours" ? "all" : "ours";
    groups.set(key, g);
  }
  // От самого широкого обхода к самому узкому: тогда покрывающий уже отобран, когда до
  // покрытого доходит очередь.
  const power = (g) => (g.creatorId === null ? 8 : 0) + (DEPTH_RANK[g.depth] ?? 0);
  const kept = [];
  for (const g of [...groups.values()].sort((a, b) => power(b) - power(a))) {
    const big = kept.find((k) => covers(k, g));
    if (big) {
      big.ids.push(...g.ids);
      big.comments = big.comments || g.comments;
      big.replies = big.replies || g.replies;
      big.allVideos = big.allVideos || g.allVideos;
      big.videos = big.videos === "all" || g.videos === "all" ? "all" : "ours";
      big.maxVideos = widerCap(big.maxVideos, g.maxVideos);
    } else {
      kept.push(g);
    }
  }
  return kept;
}

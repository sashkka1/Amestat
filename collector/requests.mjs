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

/** Покрывает ли обход группы `big` просьбы группы `small`: охват шире или тот же, глубина не мельче. */
export function covers(big, small) {
  const scopeOk = big.creatorId === null || big.creatorId === small.creatorId;
  const depthOk = big.depth === "all" || small.depth === "week";
  return scopeOk && depthOk;
}

/**
 * Просьбы одной пачки → обходы. Группы, целиком покрытые другой группой, отдают ей свои id
 * и своего обхода не получают.
 * ⚠️ «Все креаторы, неделя» НЕ покрывает «этот креатор, всё»: глубина мельче, и просьба
 * человека про полный список осталась бы невыполненной.
 * Отдаёт `[{ creatorId, depth, comments, replies, allVideos, requestedBy, ids }]`.
 * `allVideos` склеивается по «или» так же: хоть одна просьба «и не наши видео» — обход снимает у всех.
 */
export function groupRequests(rows) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const creatorId = r.creator_id ?? null;
    const depth = r.depth === "week" ? "week" : "all";
    const key = `${creatorId ?? "все"}|${depth}`;
    const g = groups.get(key) ?? { creatorId, depth, requestedBy: r.requested_by ?? null, comments: false, replies: false, allVideos: false, ids: [] };
    g.ids.push(r.id);
    // Нет поля вовсе (старая просьба, обрезанный select) — считаем «да», как было до флагов.
    g.comments = g.comments || r.comments !== false;
    g.replies = g.replies || r.replies !== false;
    // Этот флаг `default false`: нет поля — только наши, как всегда.
    g.allVideos = g.allVideos || r.all_videos === true;
    groups.set(key, g);
  }
  // От самого широкого обхода к самому узкому: тогда покрывающий уже отобран, когда до
  // покрытого доходит очередь.
  const power = (g) => (g.creatorId === null ? 2 : 0) + (g.depth === "all" ? 1 : 0);
  const kept = [];
  for (const g of [...groups.values()].sort((a, b) => power(b) - power(a))) {
    const big = kept.find((k) => covers(k, g));
    if (big) {
      big.ids.push(...g.ids);
      big.comments = big.comments || g.comments;
      big.replies = big.replies || g.replies;
      big.allVideos = big.allVideos || g.allVideos;
    } else {
      kept.push(g);
    }
  }
  return kept;
}

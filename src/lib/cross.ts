// Перекрёстность креаторов: что из строк `cross_stats` (миграция v29) показывает страница
// «Amestat Test». Здесь только расчёты — ни запросов, ни разметки: строки приходят из
// `lib/queries.ts`, рисуют их компоненты `components/stats/cross-*`.
//
// 🔴 Различаются ТРИ разные вещи, и смешивать их нельзя:
//   • перекрёстный комментарий — автор другой наш креатор той же площадки;
//   • самокомментарий — автор и есть владелец видео (обычное дело, не событие);
//   • упоминание — наш креатор назван «@именем» в подписи чужого ролика.
//
// ⚠️ Сравнивать можно только то, к чему площадка даёт имя. Лайки, просмотры, подписки и
// сохранения приходят числами без авторов — их здесь нет и быть не может.

import type { Creator, CrossStats, Platform } from "./types";

// Что известно про перекрёстность одного видео.
export type CrossInfo = {
  // Сколько текстов комментариев снято у этого видео (корневые вместе с ответами).
  total: number;
  // Комментарии от ДРУГИХ наших креаторов.
  cross: number;
  // Комментарии автора видео под своим же роликом.
  self: number;
  // Кто именно оставил перекрёстные — различные имена, по порядку.
  handles: string[];
  // Наши креаторы, упомянутые «@именем» в подписи (кроме самого автора).
  mentions: string[];
};

export const EMPTY_CROSS: CrossInfo = { total: 0, cross: 0, self: 0, handles: [], mentions: [] };

// Ключ «площадка + имя»: @orandocom.lis в TikTok и в Instagram — разные люди, и сводить их
// по одному имени значило бы рисовать перекрёстность, которой нет.
export function handleKey(platform: Platform, handle: string): string {
  return `${platform}|${handle.trim().replace(/^@/, "").toLowerCase()}`;
}

export function creatorsByHandle(creators: Creator[]): Map<string, Creator> {
  return new Map(creators.map((c) => [handleKey(c.platform, c.handle), c]));
}

// Строка на видео → взгляд по id видео. Имена в подсказке — различные и в том порядке,
// в каком их отдала база (она сортирует по имени).
export function crossByVideo(rows: CrossStats[]): Map<string, CrossInfo> {
  const out = new Map<string, CrossInfo>();
  for (const r of rows) {
    out.set(r.video_id, {
      total: r.comments_total,
      cross: r.comments_cross,
      self: r.comments_self,
      handles: [...new Set(r.cross_authors)],
      mentions: r.mentions_cross,
    });
  }
  return out;
}

// Итог по всей странице: плитка «Комментарии» показывает рядом жёлтым, сколько из них наши.
export type CrossTotals = {
  total: number;
  cross: number;
  self: number;
  // У скольких видео есть хоть один перекрёстный комментарий и у скольких — упоминание.
  crossVideos: number;
  mentionVideos: number;
};

export function crossTotals(rows: CrossStats[]): CrossTotals {
  const t: CrossTotals = { total: 0, cross: 0, self: 0, crossVideos: 0, mentionVideos: 0 };
  for (const r of rows) {
    t.total += r.comments_total;
    t.cross += r.comments_cross;
    t.self += r.comments_self;
    if (r.comments_cross > 0) t.crossVideos += 1;
    if (r.mentions_cross.length > 0) t.mentionVideos += 1;
  }
  return t;
}

// Чей это комментарий: другого нашего креатора (перекрёстный), автора самого видео
// (самокомментарий) или постороннего. Одно правило на список комментариев и на любую
// подсветку рядом — разъехавшись, они пометили бы один и тот же комментарий по-разному.
//
// `ours` — имена наших креаторов ТОЙ ЖЕ площадки в нижнем регистре; `ownerHandle` — имя
// владельца видео, тоже в нижнем регистре.
export type CommentMark = "cross" | "self" | null;

export function commentMark(
  authorHandle: string,
  ours: Set<string> | undefined,
  ownerHandle: string | null | undefined,
): CommentMark {
  const h = authorHandle.trim().replace(/^@/, "").toLowerCase();
  if (!h) return null;
  if (ownerHandle && h === ownerHandle.toLowerCase()) return "self";
  return ours?.has(h) ? "cross" : null;
}

// Имена наших креаторов одной площадки — набор для `commentMark`.
export function handlesOf(creators: Creator[], platform: Platform): Set<string> {
  return new Set(
    creators.filter((c) => c.platform === platform).map((c) => c.handle.toLowerCase()),
  );
}

// Перекрёстность по креатору: сколько он написал другим и сколько получил от других.
// Обе стороны нужны: «его комментируют» и «он комментирует» — разные поводы для разговора.
export type CrossCreator = { given: number; received: number };

export function crossByCreator(
  rows: CrossStats[],
  creators: Creator[],
): Map<string, CrossCreator> {
  const byHandle = creatorsByHandle(creators);
  const byId = new Map(creators.map((c) => [c.id, c]));
  const out = new Map<string, CrossCreator>();
  const bump = (id: string, key: keyof CrossCreator, n: number) => {
    const row = out.get(id) ?? { given: 0, received: 0 };
    row[key] += n;
    out.set(id, row);
  };
  for (const r of rows) {
    const owner = byId.get(r.creator_id);
    if (!owner) continue;
    for (const handle of r.cross_authors) {
      const author = byHandle.get(handleKey(owner.platform, handle));
      if (!author) continue;
      bump(author.id, "given", 1);
      bump(owner.id, "received", 1);
    }
  }
  return out;
}

// Матрица «кто кого комментировал»: строка — автор комментария, столбец — владелец видео.
// Диагональ — самокомментарии, и у неё свой цвет: свой комментарий под своим роликом
// перекрёстностью не является.
//
// В матрицу попадают только креаторы, у которых есть хоть одна ненулевая клетка: полный
// список с пустыми строками читался бы как поломка, а не как «эти не пересекались».
export type CrossMatrix = {
  creators: Creator[];
  // cells[строка автора][столбец владельца]; пустая клетка — 0.
  cells: number[][];
  crossTotal: number;
  selfTotal: number;
};

export function buildCrossMatrix(rows: CrossStats[], creators: Creator[]): CrossMatrix {
  const byHandle = creatorsByHandle(creators);
  const byId = new Map(creators.map((c) => [c.id, c]));
  // Ключ пары — «автор→владелец», значение — число комментариев.
  const pairs = new Map<string, number>();
  const seen = new Set<string>();
  let crossTotal = 0;
  let selfTotal = 0;

  const add = (fromId: string, toId: string, n: number) => {
    if (n <= 0) return;
    pairs.set(`${fromId}|${toId}`, (pairs.get(`${fromId}|${toId}`) ?? 0) + n);
    seen.add(fromId);
    seen.add(toId);
  };

  for (const r of rows) {
    const owner = byId.get(r.creator_id);
    if (!owner) continue;
    for (const handle of r.cross_authors) {
      const author = byHandle.get(handleKey(owner.platform, handle));
      if (!author) continue;
      add(author.id, owner.id, 1);
      crossTotal += 1;
    }
    add(owner.id, owner.id, r.comments_self);
    selfTotal += r.comments_self;
  }

  // Порядок строк и столбцов — тот же, в каком креаторы идут по сайту (`sort_order`).
  const shown = creators.filter((c) => seen.has(c.id));
  const cells = shown.map((from) => shown.map((to) => pairs.get(`${from.id}|${to.id}`) ?? 0));
  return { creators: shown, cells, crossTotal, selfTotal };
}

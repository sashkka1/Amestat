import type { VideoTableRow } from "@/components/stats/videos-table";
import type { PostItem } from "@/components/stats/top-posts";
import type { Creator } from "./types";
import type { VideoRow } from "./queries";
import type { PeriodRange } from "./period";

// Видео из базы → строка таблицы и карточка «лучших видео». Креатор подтягивается по id:
// в базе связь есть, но отдельным запросом мы её уже прочитали.
export function toTableRows(videos: VideoRow[], creators: Creator[]): VideoTableRow[] {
  const byId = new Map(creators.map((c) => [c.id, c]));
  return videos.flatMap((v) => {
    const c = byId.get(v.creator_id);
    if (!c) return [];
    return [
      {
        id: v.id,
        creatorId: c.id,
        creatorName: c.display_name || c.handle,
        handle: c.handle,
        platform: c.platform,
        avatarUrl: c.avatar_url,
        caption: v.caption,
        coverUrl: v.cover_url,
        url: v.url,
        publishedAt: v.published_at,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        saves: v.saves,
        ours: v.ours,
      },
    ];
  });
}

export function toPosts(rows: VideoTableRow[]): PostItem[] {
  return rows.map((r) => ({
    id: r.id,
    caption: r.caption,
    coverUrl: r.coverUrl,
    url: r.url,
    publishedAt: r.publishedAt,
    views: r.views,
    creatorName: r.creatorName,
    handle: r.handle,
    platform: r.platform,
  }));
}

export function publishedIn(publishedAt: string | null, range: PeriodRange): boolean {
  if (!publishedAt) return false;
  const t = new Date(publishedAt).getTime();
  return t >= range.from.getTime() && t <= range.to.getTime();
}

// Самая ранняя дата добавления — начало срока «Всё время». Пусто — год назад.
export function earliestAdded(creators: Creator[]): Date {
  let ms = Number.POSITIVE_INFINITY;
  for (const c of creators) {
    const t = new Date(c.added_at).getTime();
    if (Number.isFinite(t) && t < ms) ms = t;
  }
  return Number.isFinite(ms) ? new Date(ms) : new Date(Date.now() - 365 * 86_400_000);
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SigmaIcon, UsersIcon, VideoIcon, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiRow, totalsToKpis } from "@/components/stats/kpi-row";
import { PerformanceChart } from "@/components/stats/performance-chart";
import { TopPosts, type PostItem } from "@/components/stats/top-posts";
import { VideosTable, type VideoTableRow } from "@/components/stats/videos-table";
import { PageError } from "@/components/page";
import { VideoPanel, PANEL_METRICS, type MetricKey } from "./video-panel";
import { creatorDailyViews, creatorFollowers, videoStatsBetween, type Totals } from "@/lib/queries";
import { setVideoOurs } from "@/lib/api/videos";
import { median, sum } from "@/lib/stats";
import { changeVs, fmtCompact, fmtNum } from "@/lib/format";
import { publishedIn } from "@/lib/video-rows";
import type { PeriodRange } from "@/lib/period";
import type { PeriodState } from "@/lib/use-period";
import type { Creator, DailyViews, VideoStats } from "@/lib/types";
import { cn } from "@/lib/utils";

type Loaded = {
  key: string;
  range: PeriodRange;
  prevRange: PeriodRange;
  rows: VideoStats[];
  prevRows: VideoStats[];
  daily: DailyViews[];
  followersNow: number | null;
  followersBefore: number | null;
};

async function loadStats(
  key: string,
  creatorId: string,
  range: PeriodRange,
  previous: PeriodRange,
): Promise<Loaded> {
  const [rows, prevRows, daily, followers] = await Promise.all([
    videoStatsBetween(creatorId, range),
    videoStatsBetween(creatorId, previous),
    creatorDailyViews(creatorId, range),
    creatorFollowers(creatorId, range),
  ]);
  return {
    key,
    range,
    prevRange: previous,
    rows,
    prevRows,
    daily,
    followersNow: followers.now,
    followersBefore: followers.before,
  };
}

// Суммы считаются только по нашим видео: не наши в статистику не идут.
function totalsOf(rows: VideoStats[], range: PeriodRange): Totals {
  const ours = rows.filter((r) => r.ours);
  const t: Totals = {
    views: sum(ours.map((r) => r.views_delta)),
    likes: sum(ours.map((r) => r.likes_delta)),
    comments: sum(ours.map((r) => r.comments_delta)),
    shares: sum(ours.map((r) => r.shares_delta)),
    saves: sum(ours.map((r) => r.saves_delta)),
    engagement: 0,
    videos: ours.filter((r) => publishedIn(r.published_at, range)).length,
    followers: 0,
    followersDelta: 0,
  };
  t.engagement = t.likes + t.comments + t.shares;
  return t;
}

export function CreatorStats({
  creator,
  period,
  refreshKey,
}: {
  creator: Creator;
  period: PeriodState;
  // Меняется снаружи (креатора отредактировали) — данные перечитываются.
  refreshKey: number;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const range = period.range;
  const previous = period.previous;
  const key = range && previous ? `${creator.id}|${range.from.getTime()}|${range.to.getTime()}|${refreshKey}` : null;

  useEffect(() => {
    if (key === null || !range || !previous) return;
    let alive = true;
    loadStats(key, creator.id, range, previous).then(
      (d) => {
        if (alive) setLoaded(d);
      },
      (e: unknown) => {
        if (alive) setFailed({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
    // range/previous — объекты Date, пересобираются каждый рендер; ключ их сводит к строке.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, creator.id]);

  const error = failed !== null && failed.key === key ? failed.error : null;
  const stale = loaded !== null && loaded.key !== key;

  // Переключатель «наше»: строка меняется сразу, база — следом; не вышло — откат.
  const toggleOurs = useCallback(async (videoId: string, on: boolean) => {
    const flip = (v: boolean) =>
      setLoaded((prev) =>
        prev
          ? { ...prev, rows: prev.rows.map((r) => (r.video_id === videoId ? { ...r, ours: v } : r)) }
          : prev,
      );
    flip(on);
    const res = await setVideoOurs(videoId, on);
    if (!res.ok) {
      toast.error(res.error);
      flip(!on);
    }
  }, []);

  const summary = useMemo(() => {
    if (!loaded) return null;
    const now = totalsOf(loaded.rows, loaded.range);
    const prev = totalsOf(loaded.prevRows, loaded.prevRange);
    const ours = loaded.rows.filter((r) => r.ours);
    // Медиана считается по видео, которые за срок вышли или что-то набрали.
    const active = ours.filter((r) => r.views_delta > 0 || publishedIn(r.published_at, loaded.range));
    const medians = Object.fromEntries(
      PANEL_METRICS.map((m) => [m.key, median(active.map((r) => r[`${m.key}_delta`]))]),
    ) as Record<MetricKey, number | null>;
    const followersDelta =
      loaded.followersNow !== null && loaded.followersBefore !== null
        ? loaded.followersNow - loaded.followersBefore
        : null;
    return { now, prev, medians, oursCount: ours.length, activeCount: active.length, followersDelta };
  }, [loaded]);

  const tableRows: VideoTableRow[] = useMemo(() => {
    if (!loaded) return [];
    const name = creator.display_name || creator.handle;
    return loaded.rows.map((r) => ({
      id: r.video_id,
      creatorId: creator.id,
      creatorName: name,
      handle: creator.handle,
      platform: creator.platform,
      avatarUrl: creator.avatar_url,
      caption: r.caption,
      coverUrl: r.cover_url,
      url: r.url,
      publishedAt: r.published_at,
      views: r.views_now ?? 0,
      likes: r.likes_now ?? 0,
      comments: r.comments_now ?? 0,
      shares: r.shares_now ?? 0,
      saves: r.saves_now ?? 0,
      ours: r.ours,
    }));
  }, [loaded, creator]);

  const posts: PostItem[] = useMemo(() => {
    if (!loaded) return [];
    return tableRows
      .filter((r) => publishedIn(r.publishedAt, loaded.range))
      .map((r) => ({
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
  }, [tableRows, loaded]);

  const selected = loaded?.rows.find((r) => r.video_id === selectedId) ?? null;

  if (range === null) {
    return <p className="text-sm text-muted-foreground">Укажите обе даты: начало не позже конца.</p>;
  }
  if (error) return <PageError error={error} />;
  if (!loaded || !summary) return <StatsSkeleton />;

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", stale && "opacity-60 transition-opacity")}>
      <KpiRow items={totalsToKpis(summary.now, summary.prev)} />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[1fr_260px]">
        <PerformanceChart data={loaded.daily} />
        <div className="flex flex-col gap-4">
          <Tile
            icon={UsersIcon}
            label="Подписчики"
            value={fmtCompact(loaded.followersNow)}
            title={fmtNum(loaded.followersNow)}
            hint={
              summary.followersDelta !== null
                ? changeVs(
                    loaded.followersNow ?? 0,
                    (loaded.followersNow ?? 0) - summary.followersDelta,
                  ).text
                : "нет снимков за срок"
            }
          />
          <Tile
            icon={SigmaIcon}
            label="Медиана просмотров за срок"
            value={fmtCompact(summary.medians.views)}
            title={fmtNum(summary.medians.views)}
            hint={`видео в счёт: ${summary.activeCount}`}
          />
          <Tile
            icon={VideoIcon}
            label="Наших видео"
            value={fmtNum(summary.oursCount)}
            hint={`всего собрано: ${loaded.rows.length}`}
          />
        </div>
      </div>

      <TopPosts posts={posts} title="Лучшие видео за срок" showCreator={false} />

      {selected && (
        <VideoPanel row={selected} medians={summary.medians} onClose={() => setSelectedId(null)} />
      )}

      <VideosTable
        rows={tableRows}
        title="Видео"
        showCreator={false}
        onToggleOurs={(id, on) => void toggleOurs(id, on)}
        onRowClick={(id) => setSelectedId((prev) => (prev === id ? null : id))}
        selectedId={selectedId}
      />
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  title,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  title?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </p>
      <p className="text-2xl font-semibold tabular-nums tracking-tight" title={title}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

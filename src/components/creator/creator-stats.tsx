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
import {
  creatorDailyViews,
  creatorFollowers,
  listVideoWatch,
  videoStatsBetween,
  type Totals,
} from "@/lib/queries";
import { setVideoState } from "@/lib/api/videos";
import { videoState, type VideoState } from "@/lib/video-state";
import { median, sum } from "@/lib/stats";
import { changeVs, fmtCompact, fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
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
  // id жёлтых видео (`videos.watch`, миграция v17): video_stats_between эту колонку не
  // отдаёт, поэтому она читается отдельным запросом и живёт рядом со строками.
  watch: Set<string>;
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
  const [rows, prevRows, watch, daily, followers] = await Promise.all([
    videoStatsBetween(creatorId, range),
    videoStatsBetween(creatorId, previous),
    listVideoWatch(creatorId),
    creatorDailyViews(creatorId, range),
    creatorFollowers(creatorId, range),
  ]);
  return {
    key,
    range,
    prevRange: previous,
    rows,
    prevRows,
    watch,
    daily,
    followersNow: followers.now,
    followersBefore: followers.before,
  };
}

// Суммы — по всем видео креатора (владелец, 2026-09-08/09): пометка «наше» решает только,
// снимать ли подробности (тексты комментариев), а на общие счётчики не влияет.
function totalsOf(rows: VideoStats[], range: PeriodRange): Totals {
  const t: Totals = {
    views: sum(rows.map((r) => r.views_delta)),
    likes: sum(rows.map((r) => r.likes_delta)),
    comments: sum(rows.map((r) => r.comments_delta)),
    shares: sum(rows.map((r) => r.shares_delta)),
    saves: sum(rows.map((r) => r.saves_delta)),
    engagement: 0,
    videos: rows.filter((r) => publishedIn(r.published_at, range)).length,
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
  initialVideoId = null,
}: {
  creator: Creator;
  period: PeriodState;
  // Меняется снаружи (креатора отредактировали) — данные перечитываются.
  refreshKey: number;
  // `?video=` в адресе: карточка «Лучших видео» ведёт сюда с уже открытым роликом.
  initialVideoId?: string | null;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialVideoId);

  // Переход на ту же страницу с другим `?video=` компонент не пересоздаёт (маршрут тот же),
  // поэтому открытое видео сверяется с адресом прямо в рендере — это тот самый случай
  // «состояние подправляется при смене свойства», для которого эффект не нужен.
  const [lastFromUrl, setLastFromUrl] = useState<string | null>(initialVideoId);
  if (initialVideoId !== lastFromUrl) {
    setLastFromUrl(initialVideoId);
    if (initialVideoId) setSelectedId(initialVideoId);
  }

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

  // Состояние видео («не наше / смотрим / наше»): строка меняется сразу, база — следом;
  // не вышло — тост и откат к прежнему состоянию. Две колонки двигаются вместе, как в базе.
  const applyState = useCallback((videoId: string, next: VideoState) => {
    setLoaded((prev) => {
      if (!prev) return prev;
      const watch = new Set(prev.watch);
      if (next === "watch") watch.add(videoId);
      else watch.delete(videoId);
      return {
        ...prev,
        watch,
        rows: prev.rows.map((r) => (r.video_id === videoId ? { ...r, ours: next === "ours" } : r)),
      };
    });
  }, []);

  const changeState = useCallback(
    async (videoId: string, next: VideoState, before: VideoState) => {
      applyState(videoId, next);
      const res = await setVideoState(videoId, next);
      if (!res.ok) {
        toast.error(res.error);
        applyState(videoId, before);
      }
    },
    [applyState],
  );

  const summary = useMemo(() => {
    if (!loaded) return null;
    const now = totalsOf(loaded.rows, loaded.range);
    const prev = totalsOf(loaded.prevRows, loaded.prevRange);
    // Плитка «С подробностями» — сколько видео помечено `ours`: у них снимаются тексты
    // комментариев. На суммы и медианы пометка не влияет. Рядом — сколько жёлтых: они не
    // наши, но их историю мы всё равно собираем (миграция v17).
    const detailedCount = loaded.rows.filter((r) => r.ours).length;
    const watchCount = loaded.rows.filter((r) => !r.ours && loaded.watch.has(r.video_id)).length;
    // Медиана считается по видео, которые за срок вышли или что-то набрали.
    const active = loaded.rows.filter((r) => r.views_delta > 0 || publishedIn(r.published_at, loaded.range));
    const medians = Object.fromEntries(
      PANEL_METRICS.map((m) => [m.key, median(active.map((r) => r[`${m.key}_delta`]))]),
    ) as Record<MetricKey, number | null>;
    const followersDelta =
      loaded.followersNow !== null && loaded.followersBefore !== null
        ? loaded.followersNow - loaded.followersBefore
        : null;
    return { now, prev, medians, detailedCount, watchCount, activeCount: active.length, followersDelta };
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
      state: videoState({ ours: r.ours, watch: loaded.watch.has(r.video_id) }),
    }));
  }, [loaded, creator]);

  const posts: PostItem[] = useMemo(() => {
    if (!loaded) return [];
    return tableRows
      .filter((r) => publishedIn(r.publishedAt, loaded.range))
      .map((r) => ({
        id: r.id,
        creatorId: r.creatorId,
        caption: r.caption,
        coverUrl: r.coverUrl,
        url: r.url,
        publishedAt: r.publishedAt,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
        shares: r.shares,
        creatorName: r.creatorName,
        handle: r.handle,
        platform: r.platform,
      }));
  }, [tableRows, loaded]);

  const selected = loaded?.rows.find((r) => r.video_id === selectedId) ?? null;
  // Состояние строки до нажатия: нужно и переключателю в таблице, и в карточке — по нему
  // делается откат, если база отказала.
  const stateOf = (videoId: string): VideoState =>
    videoState({
      ours: loaded?.rows.find((r) => r.video_id === videoId)?.ours ?? false,
      watch: loaded?.watch.has(videoId) ?? false,
    });

  if (range === null) {
    return <p className="text-sm text-muted-foreground">{t("creatorStats.needBothDates")}</p>;
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
            label={t("metric.followers")}
            value={fmtCompact(loaded.followersNow)}
            title={fmtNum(loaded.followersNow)}
            hint={
              summary.followersDelta !== null
                ? changeVs(
                    loaded.followersNow ?? 0,
                    (loaded.followersNow ?? 0) - summary.followersDelta,
                  ).text
                : t("creatorStats.noSnapshots")
            }
          />
          <Tile
            icon={SigmaIcon}
            label={t("creatorStats.medianViews")}
            value={fmtCompact(summary.medians.views)}
            title={fmtNum(summary.medians.views)}
            hint={t("creatorStats.videosCounted", { n: summary.activeCount })}
          />
          <Tile
            icon={VideoIcon}
            label={t("creatorStats.detailed")}
            value={fmtNum(summary.detailedCount)}
            hint={t("creatorStats.collectedWatch", {
              total: loaded.rows.length,
              watch: summary.watchCount,
            })}
          />
        </div>
      </div>

      <TopPosts posts={posts} title={t("creatorStats.topVideos")} showCreator={false} />

      {selected && (
        <VideoPanel
          row={selected}
          state={stateOf(selected.video_id)}
          onState={(next) => void changeState(selected.video_id, next, stateOf(selected.video_id))}
          medians={summary.medians}
          platform={creator.platform}
          refreshKey={refreshKey}
          onClose={() => setSelectedId(null)}
        />
      )}

      <VideosTable
        rows={tableRows}
        title={t("metric.videos")}
        showCreator={false}
        onSetState={(id, next) => void changeState(id, next, stateOf(id))}
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

"use client";

import { useMemo } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { PeriodChip } from "@/components/period-chip";
import { KpiRow, totalsToKpis } from "@/components/stats/kpi-row";
import { PerformanceChart } from "@/components/stats/performance-chart";
import { TopPosts } from "@/components/stats/top-posts";
import { TopCreators, buildCreatorRows } from "@/components/stats/top-creators";
import { VideosTable } from "@/components/stats/videos-table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  creatorsOverview,
  dailyViewsAll,
  listCreators,
  listVideosWithCounters,
  sumOverview,
  type VideoRow,
} from "@/lib/queries";
import { earliestAdded, publishedIn, toPosts, toTableRows } from "@/lib/video-rows";
import { useLoader } from "@/lib/use-loader";
import { usePeriod } from "@/lib/use-period";
import type { Creator } from "@/lib/types";

type Base = { creators: Creator[]; videos: VideoRow[] };

async function loadBase(): Promise<Base> {
  const [creators, videos] = await Promise.all([listCreators(), listVideosWithCounters()]);
  return { creators, videos };
}

export default function HomePage() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}

function Dashboard() {
  const base = useLoader(loadBase, []);
  const creators = useMemo(() => base.data?.creators ?? [], [base.data]);
  const earliest = useMemo(() => earliestAdded(creators), [creators]);
  const period = usePeriod(earliest);

  const fromMs = period.range?.from.getTime() ?? null;
  const toMs = period.range?.to.getTime() ?? null;

  // Прошлый срок той же длины — вторым вызовом того же RPC: иначе не с чем сравнить плитки.
  const stats = useLoader(async () => {
    if (!period.range || !period.previous) return null;
    const [now, prev, daily] = await Promise.all([
      creatorsOverview(period.range),
      creatorsOverview(period.previous),
      dailyViewsAll(period.range),
    ]);
    return { now, prev, daily };
  }, [fromMs, toMs]);

  const tableRows = useMemo(
    () => (base.data ? toTableRows(base.data.videos, base.data.creators) : []),
    [base.data],
  );

  const range = period.range;
  const topPosts = useMemo(() => {
    if (!range) return [];
    return toPosts(tableRows.filter((r) => publishedIn(r.publishedAt, range)));
  }, [tableRows, range]);

  const totals = stats.data ? sumOverview(stats.data.now) : null;
  const prevTotals = stats.data ? sumOverview(stats.data.prev) : null;

  return (
    <Page
      title="Дашборд"
      subtitle="Сводка по всем креаторам"
      actions={<PeriodChip period={period} />}
    >
      {base.error ? (
        <PageError error={base.error} />
      ) : base.loading && !base.data ? (
        <PageSkeleton />
      ) : (
        <>
          {stats.error ? (
            <PageError error={stats.error} />
          ) : totals && prevTotals ? (
            <KpiRow items={totalsToKpis(totals, prevTotals)} />
          ) : (
            <Skeleton className="h-28 w-full" />
          )}

          {stats.data ? (
            <PerformanceChart data={stats.data.daily} />
          ) : (
            <Skeleton className="h-72 w-full" />
          )}

          <TopPosts posts={topPosts} />

          {stats.data ? (
            <TopCreators rows={buildCreatorRows(creators, stats.data.now)} />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          <VideosTable rows={tableRows} title="Новые видео" defaultSort="published" />
        </>
      )}
    </Page>
  );
}

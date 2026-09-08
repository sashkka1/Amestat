"use client";

import { useCallback, useMemo } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { PeriodChip } from "@/components/period-chip";
import { PlatformSwitch } from "@/components/platform-switch";
import { SyncButton } from "@/components/sync-button";
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
import {
  PLATFORM_FILTER_LABELS,
  matchesPlatform,
  usePlatformFilter,
} from "@/lib/platform-filter";
import { useIsAdmin } from "@/lib/profile-context";
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
  const allCreators = useMemo(() => base.data?.creators ?? [], [base.data]);

  // Переключатель площадки решает всё на странице: сводку, график, видео, креаторов.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;
  const creators = useMemo(
    () => allCreators.filter((c) => matchesPlatform(platformFilter, c.platform)),
    [allCreators, platformFilter],
  );
  // Начало «Всего времени» считаем по всем креаторам: иначе срок прыгал бы от переключателя.
  const earliest = useMemo(() => earliestAdded(allCreators), [allCreators]);
  const period = usePeriod(earliest);

  // «Только эта страница» в матрице обновления имеет смысл, когда страница уже сужена:
  // у менеджера — до его креаторов, у админа — переключателем площадки. Админ на «Все»
  // видит всех, и выбирать не из чего (null прячет строку).
  const isAdmin = useIsAdmin();
  const pageCreatorIds = useMemo(
    () => (isAdmin && platformFilter === "all" ? null : creators.map((c) => c.id)),
    [isAdmin, platformFilter, creators],
  );

  const fromMs = period.range?.from.getTime() ?? null;
  const toMs = period.range?.to.getTime() ?? null;
  // «Все» — это null: параметр функции необязательный, и null значит «без ограничения».
  const rpcPlatform = platformFilter === "all" ? null : platformFilter;

  // Прошлый срок той же длины — вторым вызовом того же RPC: иначе не с чем сравнить плитки.
  // creators_overview отдаёт ряды по всем видимым креаторам — площадку из них отбираем ниже,
  // по набору id; график считает база, ему площадка уходит параметром.
  const stats = useLoader(async () => {
    if (!period.range || !period.previous) return null;
    const [now, prev, daily] = await Promise.all([
      creatorsOverview(period.range),
      creatorsOverview(period.previous),
      dailyViewsAll(period.range, rpcPlatform),
    ]);
    return { now, prev, daily };
  }, [fromMs, toMs, rpcPlatform]);

  const creatorIds = useMemo(() => new Set(creators.map((c) => c.id)), [creators]);
  const nowRows = useMemo(
    () => stats.data?.now.filter((o) => creatorIds.has(o.creator_id)) ?? null,
    [stats.data, creatorIds],
  );
  const prevRows = useMemo(
    () => stats.data?.prev.filter((o) => creatorIds.has(o.creator_id)) ?? null,
    [stats.data, creatorIds],
  );

  // toTableRows выбрасывает видео тех, кого нет в переданном списке креаторов, — поэтому
  // отфильтрованный список сам оставляет и «Лучшие видео», и «Новые видео» по площадке.
  const tableRows = useMemo(
    () => (base.data ? toTableRows(base.data.videos, creators) : []),
    [base.data, creators],
  );

  const range = period.range;
  const topPosts = useMemo(() => {
    if (!range) return [];
    return toPosts(tableRows.filter((r) => publishedIn(r.publishedAt, range)));
  }, [tableRows, range]);

  const totals = nowRows ? sumOverview(nowRows) : null;
  const prevTotals = prevRows ? sumOverview(prevRows) : null;

  // Обход кончился — перечитываем и списки, и сводку за срок.
  const baseReload = base.reload;
  const statsReload = stats.reload;
  const onSynced = useCallback(() => {
    baseReload();
    statsReload();
  }, [baseReload, statsReload]);

  return (
    <Page
      title="Дашборд"
      subtitle={
        platformFilter === "all"
          ? "Сводка по всем креаторам"
          : `Сводка по ${PLATFORM_FILTER_LABELS[platformFilter]}`
      }
      actions={
        <>
          <PlatformSwitch state={platform} />
          <SyncButton scope={null} pageCreatorIds={pageCreatorIds} onDone={onSynced} />
          <PeriodChip period={period} />
        </>
      }
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

          {nowRows ? (
            <TopCreators
              rows={buildCreatorRows(creators, nowRows)}
              countLabel={
                platformFilter === "all" ? "Все креаторы" : PLATFORM_FILTER_LABELS[platformFilter]
              }
            />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          <VideosTable rows={tableRows} title="Новые видео" defaultSort="published" />
        </>
      )}
    </Page>
  );
}

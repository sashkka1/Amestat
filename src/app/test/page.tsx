"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { InfoIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { PlatformSwitch } from "@/components/platform-switch";
import { SyncButton } from "@/components/sync-button";
import { CrossMatrixPanel } from "@/components/stats/cross-matrix";
import { KpiRow, totalsToKpis } from "@/components/stats/kpi-row";
import { OverviewCards } from "@/components/stats/overview-cards";
import { Panel } from "@/components/stats/panel";
import { PeriodBar } from "@/components/stats/period-bar";
import { PerformanceChart, type ChartCreator } from "@/components/stats/performance-chart";
import { TopPosts } from "@/components/stats/top-posts";
import { TopCreators, buildCreatorRows } from "@/components/stats/top-creators";
import { VideosTable } from "@/components/stats/videos-table";
import { VideoSheet } from "@/components/video-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  bucketOf,
  creatorsOverview,
  crossStats,
  dailyViewsAll,
  listCreators,
  listVideosWithLatest,
  sumOverview,
} from "@/lib/queries";
import { setVideoState } from "@/lib/api/videos";
import {
  buildCrossMatrix,
  crossByCreator,
  crossByVideo,
  crossTotals,
  handlesOf,
} from "@/lib/cross";
import { earliestAdded, publishedIn, toPosts, toTableRows } from "@/lib/video-rows";
import { matchesScope, useCompare, useScope } from "@/lib/dashboard-prefs";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import {
  matchesPlatform,
  platformFilterLabel,
  usePlatformFilter,
} from "@/lib/platform-filter";
import { useLoader } from "@/lib/use-loader";
import { useEarliestPublished, usePeriod } from "@/lib/use-period";
import type { VideoState } from "@/lib/video-state";
import type { DailyViews } from "@/lib/types";

// «Amestat Test» — тот же дашборд, но с перекрёстной проверкой креаторов (владелец,
// 2026-09-11): «если один наш креатор комментирует видео другого нашего, система это
// помечает».
//
// 🔴 Страница НИЧЕГО не рисует заново: полоса периода, плитки, график, карточки, лучшие
// видео, лучшие креаторы и таблица — те же самые компоненты, что на дашборде. Отличие
// живёт в их необязательных свойствах: передали карту перекрёстности — появились жёлтые
// метки и колонка «Перекрёстно». Скопировать их сюда значило бы завести вторую витрину,
// которая назавтра разойдётся с первой.
//
// ⚠️ Ключи сворачивания свои (`test-…`): свёрнутый на дашборде блок не обязан быть
// свёрнутым здесь — это разные страницы с разным разговором.
//
// Только администратору (владелец, 2026-09-11): это проверочная страница, а не витрина
// менеджера.
export default function TestPage() {
  const t = useT();
  return (
    <AuthGate role="admin">
      <Suspense
        fallback={
          <Page docTitle={t("cross.pageTitle")}>
            <PageSkeleton />
          </Page>
        }
      >
        <CrossDashboard />
      </Suspense>
    </AuthGate>
  );
}

// Адрес правится мимо роутера — тем же приёмом, что на дашборде: перерисовывать страницу
// ради параметра нечего, а ссылка обязана оставаться живой.
function syncVideoParam(videoId: string | null): void {
  const url = new URL(window.location.href);
  if (videoId) url.searchParams.set("video", videoId);
  else url.searchParams.delete("video");
  window.history.replaceState(null, "", url);
}

function CrossDashboard() {
  const t = useT();
  const params = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(() => params.get("video"));
  const openVideo = useCallback((videoId: string) => {
    setOpenId(videoId);
    syncVideoParam(videoId);
  }, []);
  const closeVideo = useCallback(() => {
    setOpenId(null);
    syncVideoParam(null);
  }, []);

  const [videoStates, setVideoStates] = useState<Record<string, VideoState>>({});
  const changeState = useCallback(
    async (videoId: string, next: VideoState, before: VideoState) => {
      setVideoStates((prev) => ({ ...prev, [videoId]: next }));
      const res = await setVideoState(videoId, next);
      if (!res.ok) {
        toast.error(res.error);
        setVideoStates((prev) => ({ ...prev, [videoId]: before }));
      }
    },
    [],
  );

  const base = useLoader(listCreators, []);
  const allCreators = useMemo(() => base.data ?? [], [base.data]);

  const platform = usePlatformFilter();
  const platformFilter = platform.filter;
  const creators = useMemo(
    () => allCreators.filter((c) => matchesPlatform(platformFilter, c.platform)),
    [allCreators, platformFilter],
  );
  const addedEarliest = useMemo(() => earliestAdded(allCreators), [allCreators]);
  const earliest = useEarliestPublished(addedEarliest);
  const period = usePeriod(earliest);

  const compare = useCompare();
  const { scope, setScope } = useScope();

  const pageCreatorIds = useMemo(
    () => (platformFilter === "all" ? null : creators.map((c) => c.id)),
    [platformFilter, creators],
  );

  const fromMs = period.range?.from.getTime() ?? null;
  const toMs = period.range?.to.getTime() ?? null;
  const rpcPlatform = platformFilter === "all" ? null : platformFilter;

  // Тот же набор запросов, что у дашборда, плюс один: `cross_stats` за тот же срок, ту же
  // площадку и тот же охват. Иначе «(N) перекрёстных» стояло бы рядом с числом, посчитанным
  // по другому набору видео.
  const comparing = compare.on;
  const stats = useLoader(async () => {
    if (!period.range) return null;
    const range = period.range;
    const previous = comparing ? period.previous : null;
    const [now, prev, daily, split, videos, cross] = await Promise.all([
      creatorsOverview(range, scope),
      previous ? creatorsOverview(previous, scope) : Promise.resolve(null),
      dailyViewsAll(range, rpcPlatform, scope),
      rpcPlatform === null
        ? Promise.all([
            dailyViewsAll(range, "tiktok", scope),
            dailyViewsAll(range, "instagram", scope),
          ])
        : null,
      listVideosWithLatest(range, { platform: rpcPlatform, scope }),
      crossStats(range, { platform: rpcPlatform, scope }),
    ]);
    const tiktok: DailyViews[] = rpcPlatform === "instagram" ? [] : split ? split[0] : daily;
    const instagram: DailyViews[] = rpcPlatform === "tiktok" ? [] : split ? split[1] : daily;
    return { now, prev, daily, tiktok, instagram, videos, cross };
  }, [fromMs, toMs, rpcPlatform, comparing, scope]);

  const creatorIds = useMemo(() => new Set(creators.map((c) => c.id)), [creators]);
  const nowRows = useMemo(
    () => stats.data?.now.filter((o) => creatorIds.has(o.creator_id)) ?? null,
    [stats.data, creatorIds],
  );
  const prevRows = useMemo(
    () => stats.data?.prev?.filter((o) => creatorIds.has(o.creator_id)) ?? null,
    [stats.data, creatorIds],
  );

  // Перекрёстность в трёх видах: по видео (метки и колонка), по креатору (столбец в
  // «Лучших креаторах») и матрицей. Считается из одних и тех же строк — разойтись нечему.
  const crossRows = useMemo(
    () => (stats.data ? stats.data.cross.filter((r) => creatorIds.has(r.creator_id)) : []),
    [stats.data, creatorIds],
  );
  const byVideo = useMemo(() => crossByVideo(crossRows), [crossRows]);
  const byCreator = useMemo(() => crossByCreator(crossRows, creators), [crossRows, creators]);
  const matrix = useMemo(() => buildCrossMatrix(crossRows, creators), [crossRows, creators]);
  const totalsCross = useMemo(() => crossTotals(crossRows), [crossRows]);
  // Имена всех, кто оставил перекрёстные комментарии за срок, — для подсказки плитки.
  const crossHandles = useMemo(
    () => [...new Set(crossRows.flatMap((r) => r.cross_authors))].sort(),
    [crossRows],
  );

  const tableRows = useMemo(() => {
    const rows = stats.data ? toTableRows(stats.data.videos, creators) : [];
    return rows.map((r) => {
      const own = videoStates[r.id];
      return own && own !== r.state ? { ...r, state: own } : r;
    });
  }, [stats.data, creators, videoStates]);
  const scopedRows = useMemo(
    () => tableRows.filter((r) => matchesScope(scope, r.state)),
    [tableRows, scope],
  );

  const range = period.range;
  const topPosts = useMemo(() => {
    if (!range) return [];
    return toPosts(scopedRows.filter((r) => publishedIn(r.publishedAt, range)));
  }, [scopedRows, range]);

  const totals = nowRows ? sumOverview(nowRows) : null;
  const prevTotals = prevRows ? sumOverview(prevRows) : null;

  const topCreators = useMemo<ChartCreator[]>(() => {
    if (!nowRows) return [];
    const byId = new Map(creators.map((c) => [c.id, c]));
    return [...nowRows]
      .sort((a, b) => b.views_delta - a.views_delta)
      .slice(0, 5)
      .flatMap((o) => {
        const c = byId.get(o.creator_id);
        return c ? [{ id: c.id, name: c.display_name || c.handle }] : [];
      });
  }, [nowRows, creators]);

  const overviewDays = useMemo(() => stats.data?.daily.map((d) => d.at) ?? [], [stats.data]);
  const publishedAt = useMemo(
    () =>
      range
        ? scopedRows.flatMap((r) => (r.publishedAt && publishedIn(r.publishedAt, range) ? [r.publishedAt] : []))
        : [],
    [scopedRows, range],
  );

  const openRow = useMemo(
    () => (openId ? (tableRows.find((r) => r.id === openId) ?? null) : null),
    [tableRows, openId],
  );
  const openCreator = useMemo(
    () => (openRow ? (allCreators.find((c) => c.id === openRow.creatorId) ?? null) : null),
    [allCreators, openRow],
  );
  // Подсветка своих в комментариях открытого видео: имена наших креаторов ЕГО площадки и
  // имя владельца ролика. Площадка обязательна — @имя в TikTok и в Instagram разные люди.
  const openMark = useMemo(
    () =>
      openCreator
        ? {
            handles: handlesOf(allCreators, openCreator.platform),
            ownerHandle: openCreator.handle,
          }
        : undefined,
    [allCreators, openCreator],
  );

  const [syncKey, setSyncKey] = useState(0);
  const baseReload = base.reload;
  const statsReload = stats.reload;
  const onSynced = useCallback(() => {
    baseReload();
    statsReload();
    setSyncKey((k) => k + 1);
  }, [baseReload, statsReload]);

  return (
    <Page
      docTitle={t("cross.pageTitle")}
      toolbar={<PeriodBar period={period} compare={compare.on} onCompare={compare.set} scope={scope} onScope={setScope} />}
      actions={
        <>
          <PlatformSwitch state={platform} />
          <SyncButton scope={null} pageCreatorIds={pageCreatorIds} onDone={onSynced} />
        </>
      }
    >
      <HonestNote />

      {base.error ? (
        <PageError error={base.error} />
      ) : base.loading && !base.data ? (
        <PageSkeleton />
      ) : (
        <>
          {stats.error ? (
            <PageError error={stats.error} />
          ) : totals ? (
            <KpiRow
              items={totalsToKpis(totals, prevTotals, stats.data?.daily, {
                comments: totalsCross.cross,
                handles: crossHandles,
              })}
              collapseKey="test-kpi"
            />
          ) : (
            <Skeleton className="h-28 w-full" />
          )}

          {stats.data ? (
            <CrossSummary
              cross={totalsCross.cross}
              self={totalsCross.self}
              taken={totalsCross.total}
              crossVideos={totalsCross.crossVideos}
              mentionVideos={totalsCross.mentionVideos}
            />
          ) : (
            <Skeleton className="h-20 w-full" />
          )}

          {stats.data ? (
            <CrossMatrixPanel matrix={matrix} collapseKey="test-matrix" />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}

          {stats.data ? (
            <PerformanceChart
              serverBucket={period.range ? bucketOf(period.range) : "day"}
              data={stats.data.daily}
              collapseKey="test-chart"
              range={range}
              creators={topCreators}
            />
          ) : (
            <Skeleton className="h-72 w-full" />
          )}

          {stats.data ? (
            <OverviewCards
              collapseKey="test-overview"
              bucket={range ? bucketOf(range) : "day"}
              days={overviewDays}
              publishedAt={publishedAt}
              tiktok={stats.data.tiktok}
              instagram={stats.data.instagram}
            />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          {stats.data ? (
            <TopPosts posts={topPosts} collapseKey="test-top-posts" onSelect={openVideo} cross={byVideo} />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          {nowRows ? (
            <TopCreators
              collapseKey="test-top-creators"
              rows={buildCreatorRows(creators, nowRows, prevRows ?? [], byCreator)}
              countLabel={
                platformFilter === "all"
                  ? t("topCreators.countAll")
                  : platformFilterLabel(platformFilter)
              }
            />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          {stats.data ? (
            <VideosTable
              rows={scopedRows}
              title={t("dashboard.newVideos")}
              defaultSort="published"
              collapseKey="test-new-videos"
              onRowClick={openVideo}
              selectedId={openId}
              cross={byVideo}
            />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          <VideoSheet
            video={openRow}
            creator={openCreator}
            range={range}
            scope={scope}
            refreshKey={syncKey}
            cross={openId ? byVideo.get(openId) : undefined}
            mark={openMark}
            onState={(id, next, before) => void changeState(id, next, before)}
            onClose={closeVideo}
          />
        </>
      )}
    </Page>
  );
}

// 🔴 Честная строка вверху страницы (владелец, 2026-09-11): что мы правда сравниваем и чего
// площадки не дают. Без неё жёлтые метки читались бы как «проверено всё», а проверены
// только комментарии, ответы и упоминания: лайки, просмотры, подписки и сохранения приходят
// числами без имён, и сопоставить их не с чем ни сейчас, ни потом.
function HonestNote() {
  const t = useT();
  return (
    <Panel className="flex items-start gap-2.5 p-3 text-xs">
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-1">
        <p>
          <span className="font-medium">{t("cross.noteYes")}</span> {t("cross.noteYesText")}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">{t("cross.noteNo")}</span> {t("cross.noteNoText")}
        </p>
      </div>
    </Panel>
  );
}

// Итог перекрёстности за срок словами: сколько комментариев от чужих наших, сколько своих
// под собой и у скольких видео это случилось. Ноль не прячется — он тоже ответ.
function CrossSummary({
  cross,
  self,
  taken,
  crossVideos,
  mentionVideos,
}: {
  cross: number;
  self: number;
  taken: number;
  crossVideos: number;
  mentionVideos: number;
}) {
  const t = useT();
  return (
    <Panel className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-xs">
      <Stat label={t("cross.statCross")} value={fmtNum(cross)} accent />
      <Stat label={t("cross.statCrossVideos")} value={fmtNum(crossVideos)} accent />
      <Stat label={t("cross.statSelf")} value={fmtNum(self)} />
      <Stat label={t("cross.statMentions")} value={fmtNum(mentionVideos)} />
      {/* Знаменатель — снятые тексты, а не счётчик площадки: доля честна только к тому,
          что мы правда прочитали. */}
      <Stat label={t("cross.statTaken")} value={fmtNum(taken)} />
    </Panel>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          accent
            ? "text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-500"
            : "text-sm font-semibold tabular-nums"
        }
      >
        {value}
      </span>
    </span>
  );
}

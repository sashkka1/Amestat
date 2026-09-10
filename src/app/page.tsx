"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { PlatformSwitch } from "@/components/platform-switch";
import { SyncButton } from "@/components/sync-button";
import { KpiRow, totalsToKpis } from "@/components/stats/kpi-row";
import { OverviewCards } from "@/components/stats/overview-cards";
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
  dailyViewsAll,
  listCreators,
  listVideosWithLatest,
  sumOverview,
} from "@/lib/queries";
import { setVideoState } from "@/lib/api/videos";
import { earliestAdded, publishedIn, toPosts, toTableRows } from "@/lib/video-rows";
import { matchesScope, useCompare, useScope } from "@/lib/dashboard-prefs";
import { useT } from "@/lib/i18n";
import {
  matchesPlatform,
  platformFilterLabel,
  usePlatformFilter,
} from "@/lib/platform-filter";
import { useIsAdmin } from "@/lib/profile-context";
import { useLoader } from "@/lib/use-loader";
import { useEarliestPublished, usePeriod } from "@/lib/use-period";
import type { VideoState } from "@/lib/video-state";
import type { DailyViews } from "@/lib/types";

// `?video=<id>` — какой ролик открыт шторкой (владелец, 2026-09-09): ссылку с ним можно
// дать, и страница откроется с той же подробной статистикой. useSearchParams в статике
// требует Suspense — тем же приёмом, что карточка креатора.
export default function HomePage() {
  const t = useT();
  return (
    <AuthGate>
      <Suspense
        fallback={
          <Page docTitle={t("nav.dashboard")}>
            <PageSkeleton />
          </Page>
        }
      >
        <Dashboard />
      </Suspense>
    </AuthGate>
  );
}

// Адрес правится мимо роутера: перерисовывать страницу ради параметра нечего, а ссылка
// обязана оставаться живой. basePath сюда не вмешивается — путь берётся из самого адреса.
function syncVideoParam(videoId: string | null): void {
  const url = new URL(window.location.href);
  if (videoId) url.searchParams.set("video", videoId);
  else url.searchParams.delete("video");
  window.history.replaceState(null, "", url);
}

function Dashboard() {
  const t = useT();
  const params = useSearchParams();
  // Параметр адреса читается один раз, при первом рендере: дальше открытым видео ведает
  // состояние, а адрес подправляется за ним (`syncVideoParam`).
  const [openId, setOpenId] = useState<string | null>(() => params.get("video"));
  const openVideo = useCallback((videoId: string) => {
    setOpenId(videoId);
    syncVideoParam(videoId);
  }, []);
  const closeVideo = useCallback(() => {
    setOpenId(null);
    syncVideoParam(null);
  }, []);

  // Состояние видео, изменённое из шторки: строки приезжают загрузчиком и правке не
  // поддаются, поэтому правка живёт рядом и ложится на них поверх — так строка в таблице
  // зеленеет сразу, не дожидаясь перечитывания срока.
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

  // Список креаторов — единственное, что странице нужно до выбора срока: по нему считается
  // начало «Всего времени» и фильтр площадки. Видео уехали в загрузку срока (ниже), поэтому
  // страница показывается сразу, не дожидаясь тысячи строк.
  const base = useLoader(listCreators, []);
  const allCreators = useMemo(() => base.data ?? [], [base.data]);

  // Переключатель площадки решает всё на странице: сводку, график, видео, креаторов.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;
  const creators = useMemo(
    () => allCreators.filter((c) => matchesPlatform(platformFilter, c.platform)),
    [allCreators, platformFilter],
  );
  // Начало «Всего времени» считаем по всем креаторам: иначе срок прыгал бы от переключателя.
  const addedEarliest = useMemo(() => earliestAdded(allCreators), [allCreators]);
  const earliest = useEarliestPublished(addedEarliest);
  const period = usePeriod(earliest);

  // Полоса периода держит ещё две настройки страницы, и обе помнятся между заходами
  // (`lib/dashboard-prefs.ts`): сравнивать ли срок с прошлым и какие видео считать.
  const compare = useCompare();
  const { scope, setScope } = useScope();

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
  //
  // Ряды по площадкам нужны карточкам «Тренд просмотров» и «Доля площадок». Своей миграции
  // у них нет: это тот же daily_views_all, позванный с p_platform. На «Все» он зовётся дважды,
  // а при выбранной площадке второго запроса нет вовсе — её ряд и есть тот `daily`, что уже
  // прочитан для графика.
  //
  // ⚠️ Сравнение выключено — прошлый срок не читается вовсе: это второй такой же вызов
  // creators_overview на каждую смену срока, и он никому не нужен, пока дельты не показывают.
  //
  // ⚠️ Охват тоже уходит в базу (миграция v22) и стоит в списке зависимостей: переключили
  // «Только наши / Все видео» — плитки, «Динамика» и тренд площадок перечитываются.
  //
  // ⚠️ Видео читаются здесь же и тем же сроком (миграция v23): один вызов `videos_with_latest`
  // вместо девяти запросов «страницы videos + пачки video_latest», и он уходит в общий
  // Promise.all рядом со сводкой. Отсюда берут строки и «Новые видео», и «Лучшие видео».
  const comparing = compare.on;
  const stats = useLoader(async () => {
    if (!period.range) return null;
    const range = period.range;
    const previous = comparing ? period.previous : null;
    const [now, prev, daily, split, videos] = await Promise.all([
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
    ]);
    const tiktok: DailyViews[] = rpcPlatform === "instagram" ? [] : split ? split[0] : daily;
    const instagram: DailyViews[] = rpcPlatform === "tiktok" ? [] : split ? split[1] : daily;
    return { now, prev, daily, tiktok, instagram, videos };
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

  // toTableRows выбрасывает видео тех, кого нет в переданном списке креаторов, — поэтому
  // отфильтрованный список сам оставляет и «Лучшие видео», и «Новые видео» по площадке.
  //
  // Охват «Только наши» ложится тем же слоем на то, что считается прямо здесь, из видео:
  // «Лучшие видео», «Новые видео» и столбцы публикаций в карточках. Суммы из базы теперь
  // сужены тем же условием (миграция v22), поэтому клиентский фильтр и серверный отбор
  // говорят про один и тот же набор видео — таблица сходится с плиткой над ней.
  const tableRows = useMemo(() => {
    const rows = stats.data ? toTableRows(stats.data.videos, creators) : [];
    // Правки из шторки поверх прочитанного: пока срок не перечитан, база и экран сходятся.
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

  // Пятёрка для режима «По креаторам» на графике: лучшие по просмотрам за срок. Сами ряды
  // график дочитывает сам и только когда режим включат.
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

  // Сетка дней и публикации для карточек под графиком — из уже прочитанного: дни те же,
  // по которым идёт «Динамика», видео — те же, что стоят в таблицах страницы.
  const overviewDays = useMemo(() => stats.data?.daily.map((d) => d.day) ?? [], [stats.data]);
  const publishedAt = useMemo(
    () =>
      range
        ? scopedRows.flatMap((r) => (r.publishedAt && publishedIn(r.publishedAt, range) ? [r.publishedAt] : []))
        : [],
    [scopedRows, range],
  );

  // Открытое шторкой видео и его креатор: id хранится в состоянии и в адресе, а строка со
  // счётчиками и креатор ищутся среди уже прочитанного. Креатор берётся из полного списка:
  // ссылку могли дать на ролик с другой площадкой, чем выбрана переключателем.
  const openRow = useMemo(
    () => (openId ? (tableRows.find((r) => r.id === openId) ?? null) : null),
    [tableRows, openId],
  );
  const openCreator = useMemo(
    () => (openRow ? (allCreators.find((c) => c.id === openRow.creatorId) ?? null) : null),
    [allCreators, openRow],
  );

  // Обход кончился — перечитываем и списки, и сводку за срок; шторка по этому же счётчику
  // перечитывает историю и комментарии открытого видео.
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
      docTitle={t("nav.dashboard")}
      toolbar={<PeriodBar period={period} compare={compare.on} onCompare={compare.set} scope={scope} onScope={setScope} />}
      actions={
        <>
          <PlatformSwitch state={platform} />
          <SyncButton scope={null} pageCreatorIds={pageCreatorIds} onDone={onSynced} />
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
          ) : totals ? (
            /* Дневной ряд у плиток тот же, что рисует «Динамика»: спарклайн в плитке —
               это её кусок, а не отдельный расчёт.
               ⚠️ Ждать прошлый срок нельзя: пока он едет (сравнение только что включили),
               плитки уезжали в скелет — и число просмотров пропадало с экрана на ровном
               месте. Нет прошлого — плитка стоит без строки дельты, и это честно. */
            <KpiRow items={totalsToKpis(totals, prevTotals, stats.data?.daily)} collapseKey="kpi" />
          ) : (
            <Skeleton className="h-28 w-full" />
          )}

          {stats.data ? (
            <PerformanceChart
              serverBucket={period.range ? bucketOf(period.range) : "day"}
              data={stats.data.daily}
              collapseKey="chart"
              range={range}
              creators={topCreators}
            />
          ) : (
            <Skeleton className="h-72 w-full" />
          )}

          {stats.data ? (
            <OverviewCards
              collapseKey="overview"
              days={overviewDays}
              publishedAt={publishedAt}
              tiktok={stats.data.tiktok}
              instagram={stats.data.instagram}
            />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          {stats.data ? (
            <TopPosts posts={topPosts} collapseKey="top-posts" onSelect={openVideo} />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          {nowRows ? (
            <TopCreators
              collapseKey="top-creators"
              rows={buildCreatorRows(creators, nowRows, prevRows ?? [])}
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
              collapseKey="new-videos"
              onRowClick={openVideo}
              selectedId={openId}
            />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}

          {/* Та же панель, что встроена в карточку креатора, — здесь шторкой справа: со
              страницы не уводит, а ссылка с `?video=` открывает её сразу. */}
          <VideoSheet
            video={openRow}
            creator={openCreator}
            range={range}
            scope={scope}
            refreshKey={syncKey}
            onState={(id, next, before) => void changeState(id, next, before)}
            onClose={closeVideo}
          />
        </>
      )}
    </Page>
  );
}

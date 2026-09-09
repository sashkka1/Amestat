"use client";

import { useCallback, useMemo } from "react";
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
import { matchesScope, useCompare, useScope } from "@/lib/dashboard-prefs";
import { useT } from "@/lib/i18n";
import {
  matchesPlatform,
  platformFilterLabel,
  usePlatformFilter,
} from "@/lib/platform-filter";
import { useIsAdmin } from "@/lib/profile-context";
import { useLoader } from "@/lib/use-loader";
import { usePeriod } from "@/lib/use-period";
import type { Creator, DailyViews } from "@/lib/types";

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
  const t = useT();
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
  const comparing = compare.on;
  const stats = useLoader(async () => {
    if (!period.range) return null;
    const range = period.range;
    const previous = comparing ? period.previous : null;
    const [now, prev, daily, split] = await Promise.all([
      creatorsOverview(range, scope),
      previous ? creatorsOverview(previous, scope) : Promise.resolve(null),
      dailyViewsAll(range, rpcPlatform, scope),
      rpcPlatform === null
        ? Promise.all([
            dailyViewsAll(range, "tiktok", scope),
            dailyViewsAll(range, "instagram", scope),
          ])
        : null,
    ]);
    const tiktok: DailyViews[] = rpcPlatform === "instagram" ? [] : split ? split[0] : daily;
    const instagram: DailyViews[] = rpcPlatform === "tiktok" ? [] : split ? split[1] : daily;
    return { now, prev, daily, tiktok, instagram };
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
  const tableRows = useMemo(
    () => (base.data ? toTableRows(base.data.videos, creators) : []),
    [base.data, creators],
  );
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

  // Обход кончился — перечитываем и списки, и сводку за срок.
  const baseReload = base.reload;
  const statsReload = stats.reload;
  const onSynced = useCallback(() => {
    baseReload();
    statsReload();
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
          ) : totals && (!compare.on || prevTotals) ? (
            /* Дневной ряд у плиток тот же, что рисует «Динамика»: спарклайн в плитке —
               это её кусок, а не отдельный расчёт. */
            <KpiRow items={totalsToKpis(totals, prevTotals, stats.data?.daily)} collapseKey="kpi" />
          ) : (
            <Skeleton className="h-28 w-full" />
          )}

          {stats.data ? (
            <PerformanceChart
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

          <TopPosts posts={topPosts} collapseKey="top-posts" />

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

          <VideosTable
            rows={scopedRows}
            title={t("dashboard.newVideos")}
            defaultSort="published"
            collapseKey="new-videos"
          />
        </>
      )}
    </Page>
  );
}

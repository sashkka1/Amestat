"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SigmaIcon, UsersIcon, VideoIcon, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiRow, totalsToKpis } from "@/components/stats/kpi-row";
import { PostsPerDay } from "@/components/stats/overview-cards";
import { Panel, PanelHead } from "@/components/stats/panel";
import { PerformanceChart } from "@/components/stats/performance-chart";
import { TopPosts, type PostItem } from "@/components/stats/top-posts";
import { VideosTable, type VideoTableRow } from "@/components/stats/videos-table";
import { PageError } from "@/components/page";
import { VideoSheet } from "@/components/video-sheet";
import { activeRows, panelMedians } from "./video-panel";
import {
  bucketOf,
  creatorDailyViews,
  creatorFollowers,
  crossStats,
  listVideoWatch,
  videoStatsBetween,
  type Totals,
} from "@/lib/queries";
import { setVideoState } from "@/lib/api/videos";
import { crossByVideo, crossTotals, handlesOf } from "@/lib/cross";
import { matchesScope, useCompare, useScope, type Scope } from "@/lib/dashboard-prefs";
import { videoState, type VideoState } from "@/lib/video-state";
import { engagementOf, sum } from "@/lib/stats";
import { changeVs, fmtCompact, fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { publishedIn } from "@/lib/video-rows";
import type { PeriodRange } from "@/lib/period";
import type { PeriodState } from "@/lib/use-period";
import type { Creator, CrossStats, DailyViews, VideoStats } from "@/lib/types";
import { cn } from "@/lib/utils";

type Loaded = {
  key: string;
  range: PeriodRange;
  // Прошлый срок и его строки — только когда сравнение включено полосой периода. Выключено —
  // второго вызова video_stats_between нет вовсе, и дельту у плиток брать неоткуда.
  prevRange: PeriodRange | null;
  rows: VideoStats[];
  prevRows: VideoStats[] | null;
  // id жёлтых видео (`videos.watch`, миграция v17): video_stats_between эту колонку не
  // отдаёт, поэтому она читается отдельным запросом и живёт рядом со строками.
  watch: Set<string>;
  daily: DailyViews[];
  followersNow: number | null;
  followersBefore: number | null;
  // Перекрёстность видео этого креатора (миграция v29) — строки того же срока и охвата.
  cross: CrossStats[];
};

async function loadStats(
  key: string,
  creator: Creator,
  range: PeriodRange,
  previous: PeriodRange | null,
  scope: Scope,
): Promise<Loaded> {
  const creatorId = creator.id;
  const [rows, prevRows, watch, daily, followers, cross] = await Promise.all([
    videoStatsBetween(creatorId, range, scope),
    previous ? videoStatsBetween(creatorId, previous, scope) : Promise.resolve(null),
    listVideoWatch(creatorId),
    creatorDailyViews(creatorId, range, scope),
    creatorFollowers(creatorId, range),
    // Своего креатора у `cross_stats` в параметрах нет: сужаем площадкой, а чужие строки
    // отсеиваем здесь. Сверка имён всё равно идёт по всем нашим креаторам той же площадки.
    crossStats(range, { platform: creator.platform, scope }),
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
    cross: cross.filter((r) => r.creator_id === creatorId),
  };
}

// Суммы — по тем строкам, что пришли из базы: при охвате «Все видео» это все видео креатора,
// при «Только наши» — наши и жёлтые (владелец, 2026-09-09). Пометка `ours` при этом
// по-прежнему решает и другое: снимать ли подробности (тексты комментариев).
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
  // Формула вовлечённости — одна на весь сайт (`lib/stats.ts`), та же, что у сводки
  // дашборда в `sumOverview`.
  t.engagement = engagementOf(t);
  return t;
}

// Адрес правится мимо роутера — тем же приёмом, что на дашборде: перерисовывать страницу
// ради параметра нечего, а ссылка обязана оставаться живой.
function syncVideoParam(videoId: string | null): void {
  const url = new URL(window.location.href);
  if (videoId) url.searchParams.set("video", videoId);
  else url.searchParams.delete("video");
  window.history.replaceState(null, "", url);
}

export function CreatorStats({
  creator,
  allCreators,
  period,
  refreshKey,
  initialVideoId = null,
}: {
  creator: Creator;
  // Все видимые креаторы — для подсветки своих в комментариях открытого ролика.
  allCreators: Creator[];
  period: PeriodState;
  // Меняется снаружи (креатора отредактировали) — данные перечитываются.
  refreshKey: number;
  // `?video=` в адресе: ссылка с открытым роликом открывает шторку сразу.
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

  // Открытие и закрытие ролика ведёт и адрес: ссылку с `?video=` можно дать, и карточка
  // откроется с той же шторкой — ровно как на дашборде.
  const openVideo = useCallback((videoId: string) => {
    setSelectedId(videoId);
    syncVideoParam(videoId);
  }, []);
  const closeVideo = useCallback(() => {
    setSelectedId(null);
    syncVideoParam(null);
  }, []);

  // Полоса периода на странице держит эти две настройки; сторы общие с дашбордом
  // (`lib/dashboard-prefs.ts`), поэтому выбор один на весь сайт.
  const compare = useCompare();
  const { scope } = useScope();
  const comparing = compare.on;

  const range = period.range;
  // Сравнение выключено — прошлый срок не читается вовсе.
  const previous = comparing ? period.previous : null;
  // Охват стоит в ключе: он уходит в базу (миграция v22), значит переключение «Только наши /
  // Все видео» обязано перечитать и строки, и ряд «Динамики».
  const key = range
    ? `${creator.id}|${range.from.getTime()}|${range.to.getTime()}|${comparing ? "cmp" : "solo"}|${scope}|${refreshKey}`
    : null;

  useEffect(() => {
    if (key === null || !range) return;
    let alive = true;
    loadStats(key, creator, range, previous, scope).then(
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
    const prev =
      loaded.prevRows && loaded.prevRange ? totalsOf(loaded.prevRows, loaded.prevRange) : null;
    // Плитка «С подробностями» — сколько видео помечено `ours`: у них снимаются тексты
    // комментариев. На суммы и медианы пометка не влияет. Рядом — сколько жёлтых: они не
    // наши, но их историю мы всё равно собираем (миграция v17).
    const detailedCount = loaded.rows.filter((r) => r.ours).length;
    const watchCount = loaded.rows.filter((r) => !r.ours && loaded.watch.has(r.video_id)).length;
    // Медиана считается по видео, которые за срок вышли или что-то набрали. Отбор и расчёт —
    // общие с шторкой дашборда (`video-panel.tsx`), чтобы «норма» у одного видео была одна.
    const active = activeRows(loaded.rows, loaded.range);
    const medians = panelMedians(active);
    const followersDelta =
      loaded.followersNow !== null && loaded.followersBefore !== null
        ? loaded.followersNow - loaded.followersBefore
        : null;
    // Перекрёстность за срок целиком: жёлтое «(N)» у плитки «Комментарии» и имена в подсказке.
    const cross = crossTotals(loaded.cross);
    const crossHandles = [...new Set(loaded.cross.flatMap((r) => r.cross_authors))].sort();
    return {
      now,
      prev,
      medians,
      detailedCount,
      watchCount,
      activeCount: active.length,
      followersDelta,
      cross,
      crossHandles,
    };
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

  // Охват «Только наши» ложится на всё, что считается прямо здесь, из видео: «Лучшие видео»,
  // таблицу и столбцы публикаций. База при сужённом охвате «не наши» строки уже не отдаёт
  // (миграция v22), так что фильтр — страховка от расхождения определений, а не второй отбор.
  const scopedRows = useMemo(
    () => tableRows.filter((r) => matchesScope(scope, r.state)),
    [tableRows, scope],
  );

  // Сетка дней и даты публикаций для карточки «Публикации по дням» — из уже прочитанного:
  // дни те же, по которым идёт «Динамика».
  const overviewDays = useMemo(() => loaded?.daily.map((d) => d.at) ?? [], [loaded]);
  const publishedAt = useMemo(
    () =>
      loaded
        ? scopedRows.flatMap((r) =>
            r.publishedAt && publishedIn(r.publishedAt, loaded.range) ? [r.publishedAt] : [],
          )
        : [],
    [scopedRows, loaded],
  );

  const posts: PostItem[] = useMemo(() => {
    if (!loaded) return [];
    return scopedRows
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
  }, [scopedRows, loaded]);

  // Перекрёстность по id видео: три числа в колонке комментариев таблицы, в «Лучших видео»
  // и в шторке. Строки уже сужены до этого креатора в `loadStats`.
  const byVideo = useMemo(() => crossByVideo(loaded?.cross ?? []), [loaded]);
  // Открытый шторкой ролик — строка таблицы, как на дашборде: шторке нужны обложка, ссылка
  // и состояние, а не только счётчики.
  const openRow = useMemo(
    () => (selectedId ? (tableRows.find((r) => r.id === selectedId) ?? null) : null),
    [tableRows, selectedId],
  );
  // Подсветка своих в комментариях: наши креаторы ЕГО площадки и имя владельца ролика.
  const mark = useMemo(
    () => ({ handles: handlesOf(allCreators, creator.platform), ownerHandle: creator.handle }),
    [allCreators, creator.platform, creator.handle],
  );

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
      {/* Дневной ряд у плиток тот же, что рисует «Динамика»: спарклайн в плитке — это её
          кусок, а не отдельный расчёт. Прошлого срока нет (сравнение выключено) — строки
          с дельтой у плитки нет вовсе. */}
      <KpiRow
        items={totalsToKpis(summary.now, summary.prev, loaded.daily, {
          comments: summary.cross.cross,
          handles: summary.crossHandles,
        })}
        collapseKey="creator.kpi"
      />

      {/* Три плитки про самого креатора: их считает не сводка по видео, а снимки профиля
          и медианы за срок, поэтому они стоят своим блоком. */}
      <Panel collapseKey="creator.extra">
        <PanelHead title={t("creatorStats.extraTitle")} />
        <div className="grid grid-cols-1 divide-y divide-border border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
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
      </Panel>

      {/* `creators` не передаём: режим «По креаторам» на карточке одного креатора
          сравнивать не с кем. */}
      <PerformanceChart data={loaded.daily} serverBucket={bucketOf(loaded.range)} collapseKey="creator.chart" />

      {/* Из ряда обзора здесь только публикации по дням: площадка одна, поэтому ни тренда
          по площадкам, ни доли не бывает. */}
      <PostsPerDay
        days={overviewDays}
        publishedAt={publishedAt}
        bucket={bucketOf(loaded.range)}
        collapseKey="creator.posts"
      />

      <TopPosts
        posts={posts}
        title={t("creatorStats.topVideos")}
        showCreator={false}
        collapseKey="creator.top-posts"
        onSelect={openVideo}
        cross={byVideo}
      />

      <VideosTable
        rows={scopedRows}
        title={t("metric.videos")}
        collapseKey="creator.videos"
        showCreator={false}
        cross={byVideo}
        onSetState={(id, next) => void changeState(id, next, stateOf(id))}
        onRowClick={(id) => (id === selectedId ? closeVideo() : openVideo(id))}
        selectedId={selectedId}
      />

      {/* Подробности ролика — шторкой справа, а не врезкой посреди страницы (владелец,
          2026-09-12: «видео всегда открывается шторкой справа»). Строки за срок у карточки
          уже прочитаны, поэтому шторка берёт их готовыми и в базу не ходит. */}
      <VideoSheet
        video={openRow}
        creator={creator}
        range={loaded.range}
        scope={scope}
        refreshKey={refreshKey}
        rows={loaded.rows}
        cross={selectedId ? byVideo.get(selectedId) : undefined}
        mark={mark}
        onState={(id, next, before) => void changeState(id, next, before)}
        onClose={closeVideo}
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
  // Рамку и фон даёт панель-хозяйка, плитки внутри неё разделены линиями — как в `KpiRow`.
  return (
    <div className="flex flex-col gap-1 p-4">
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

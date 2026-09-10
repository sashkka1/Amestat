"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { Avatar } from "@/components/avatar";
import { CreatorLabel } from "@/components/creator-label";
import { PlatformSwitch } from "@/components/platform-switch";
import { TagPill } from "@/components/tag-pill";
import { LocalTime } from "@/components/local-time";
import { TagPicker } from "@/components/creators/tag-picker";
import { TagsDialog } from "@/components/creators/tags-dialog";
import { AddCreatorDialog } from "@/components/creators/add-creator-dialog";
import { RowSyncButton } from "@/components/creators/row-sync-button";
import { Delta } from "@/components/stats/delta";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { SortHead, nextSort, type SortDir } from "@/components/stats/sort-head";
import { Sparkline } from "@/components/stats/sparkline";
import { ScopeSwitch } from "@/components/stats/period-bar";
import { PeriodChip } from "@/components/period-chip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  creatorDailyViews,
  creatorsOverview,
  listCreatorLatest,
  listCreatorTags,
  listCreators,
  listTags,
} from "@/lib/queries";
import { fmtDayAxis, fmtNum } from "@/lib/format";
import { useScope, type Scope } from "@/lib/dashboard-prefs";
import { useT } from "@/lib/i18n";
import { matchesPlatform, platformFilterLabel, usePlatformFilter } from "@/lib/platform-filter";
import { useLoader } from "@/lib/use-loader";
import { useEarliestPublished, usePeriod } from "@/lib/use-period";
import { useSyncQueue } from "@/lib/use-sync-queue";
import { useProfile } from "@/lib/profile-context";
import { earliestAdded } from "@/lib/video-rows";
import { periodLabel, toDateInputValue, type PeriodRange } from "@/lib/period";
import type { Creator, CreatorLatest, CreatorOverview, CreatorTag, Tag } from "@/lib/types";

// Списки страницы: они от срока не зависят вовсе и читаются один раз.
type Base = {
  creators: Creator[];
  tags: Tag[];
  creatorTags: CreatorTag[];
  latest: CreatorLatest[];
};

// Сводка за выбранный срок — отдельной загрузкой: сменили срок, и перечитывается только она.
type Stats = {
  overview: CreatorOverview[];
  // Срок, за который сосчитан `overview`: по нему же читаются ряды спарклайнов и прошлый
  // срок — иначе колонка сравнивала бы числа за чуть разные сроки.
  range: PeriodRange;
  previous: PeriodRange | null;
};

// Спарклайн — это отдельный запрос на каждого креатора. До этого числа они читаются пачкой
// после списка, дальше столбец остаётся с одним числом и дельтой: сотня RPC ради рисунка
// в ячейке дороже самой страницы.
const SPARK_LIMIT = 30;

async function loadBase(): Promise<Base> {
  const [creators, tags, creatorTags, latest] = await Promise.all([
    listCreators(),
    listTags(),
    listCreatorTags(),
    listCreatorLatest(),
  ]);
  return { creators, tags, creatorTags, latest };
}

// Дополнение к столбцу «За период»: прошлый срок той же длины для дельты и дневные ряды для
// спарклайнов. Читается ПОСЛЕ таблицы и отдельно от неё — таблица показывается сразу,
// а рисунки и проценты появляются, когда приедут.
type Trend = { prev: Map<string, number>; series: Map<string, number[]> };

async function loadTrend(
  creators: Creator[],
  range: PeriodRange,
  previous: PeriodRange | null,
  scope: Scope,
): Promise<Trend> {
  const ids = creators.map((c) => c.id);
  const [prev, series] = await Promise.all([
    previous ? creatorsOverview(previous, scope) : Promise.resolve([]),
    ids.length <= SPARK_LIMIT
      ? Promise.all(ids.map((id) => creatorDailyViews(id, range, scope)))
      : Promise.resolve(null),
  ]);
  return {
    prev: new Map(prev.map((o) => [o.creator_id, o.views_delta])),
    series: new Map(series ? ids.map((id, i) => [id, series[i].map((d) => d.views)]) : []),
  };
}

// Подпись под названием столбца: «2 Sep → 9 Sep». Даты честнее слова «Custom range»,
// а на пресетах повторяют то же, что написано в пилюле срока.
function rangeCaption(range: PeriodRange | null): string | null {
  if (!range) return null;
  return `${fmtDayAxis(toDateInputValue(range.from))} → ${fmtDayAxis(toDateInputValue(range.to))}`;
}

export default function CreatorsPage() {
  return (
    <AuthGate>
      <CreatorsScreen />
    </AuthGate>
  );
}

type Key = "name" | "followers" | "videos" | "views" | "synced";

function CreatorsScreen() {
  const t = useT();
  const profile = useProfile();
  // Все три переключателя те же, что на дашборде, и положение у них общее через localStorage
  // (`lib/dashboard-prefs.ts`). Полной полосы периода здесь нет — сравнение и охват в этой
  // таблице всегда включены, — поэтому в шапке стоят пилюля срока и сегмент охвата.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;
  const { scope, setScope } = useScope();

  // Списки читаются один раз: от срока они не зависят.
  const base = useLoader(loadBase, []);
  const creatorsAll = useMemo(() => base.data?.creators ?? [], [base.data]);
  // Начало «Всего времени» — по всем креаторам, как на дашборде: иначе срок прыгал бы
  // от фильтра площадки.
  const addedEarliest = useMemo(() => earliestAdded(creatorsAll), [creatorsAll]);
  const earliest = useEarliestPublished(addedEarliest);
  const period = usePeriod(earliest);

  // Сводка за срок — своей загрузкой. Охват уходит в базу (миграция v22): и столбец
  // «За период», и спарклайны считаются по сужённому набору видео, поэтому смена охвата
  // перечитывает её так же, как смена срока.
  const fromMs = period.range?.from.getTime() ?? null;
  const toMs = period.range?.to.getTime() ?? null;
  const stats = useLoader(async (): Promise<Stats | null> => {
    if (!period.range) return null;
    const range = period.range;
    return { overview: await creatorsOverview(range, scope), range, previous: period.previous };
  }, [fromMs, toMs, scope]);

  const error = base.error ?? stats.error;
  // 🔴 Скелет держится, пока не пришли ОБЕ загрузки: список без сводки — это таблица, в
  // которой «Видео» и «За период» стоят нулями, а выглядит она как готовая. Именно так
  // и пропадали числа. Перечитывание срока скелета уже не вызывает: старая сводка остаётся
  // на экране, пока не приедет новая.
  const loading = (base.loading && !base.data) || (stats.loading && !stats.data);
  const data = base.data;
  // Диалоги и очередь перечитывают страницу целиком: список мог измениться, а вместе с ним
  // и сводка за срок.
  const baseReload = base.reload;
  const statsReload = stats.reload;
  const reload = useCallback(() => {
    baseReload();
    statsReload();
  }, [baseReload, statsReload]);

  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<Key>("views");
  const [dir, setDir] = useState<SortDir>("desc");

  // Очередь обновления — одна на таблицу. Список креаторов для неё берётся весь, до фильтра
  // площадки и поиска: иначе просьба переставала бы отслеживаться, стоило спрятать строку.
  const queueIds = useMemo(() => data?.creators.map((c) => c.id) ?? [], [data]);
  const queue = useSyncQueue(queueIds, reload);

  // Тренд столбца «За период» — вторым заходом, уже после списка: пока он едет, таблица
  // стоит и работает, просто без спарклайнов и процентов.
  const [trend, setTrend] = useState<Trend | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const statsData = stats.data;
  useEffect(() => {
    if (!data || !statsData) return;
    let alive = true;
    loadTrend(data.creators, statsData.range, statsData.previous, scope).then(
      (d) => {
        if (!alive) return;
        setTrendError(null);
        setTrend(d);
      },
      (e: unknown) => {
        // Молчать нельзя: столбец просто остался бы без половины содержимого, и это
        // выглядело бы как «данных нет», а не как «не прочиталось».
        if (alive) setTrendError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
    // scope здесь же: страница перечитывается при его смене, и тренд обязан ехать за ней.
  }, [data, statsData, scope]);

  // Галочки тегов меняются сразу, база — следом. Перечитали страницу — берём свежее.
  const [localTags, setLocalTags] = useState<CreatorTag[]>([]);
  const [prevTags, setPrevTags] = useState<CreatorTag[] | null>(null);
  if (data && prevTags !== data.creatorTags) {
    setPrevTags(data.creatorTags);
    setLocalTags(data.creatorTags);
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const latestById = new Map(data.latest.map((l) => [l.creator_id, l]));
    const overviewById = new Map((statsData?.overview ?? []).map((o) => [o.creator_id, o]));
    const tagById = new Map(data.tags.map((t) => [t.id, t]));
    const tagsByCreator = new Map<string, Tag[]>();
    for (const ct of localTags) {
      const t = tagById.get(ct.tag_id);
      if (!t) continue;
      const arr = tagsByCreator.get(ct.creator_id) ?? [];
      arr.push(t);
      tagsByCreator.set(ct.creator_id, arr);
    }
    // Площадка отсеивается здесь, до поиска и тегов: счётчик «N из M» считает по строкам
    // этого списка, значит и M должно быть уже по выбранной площадке.
    return data.creators
      .filter((c) => matchesPlatform(platformFilter, c.platform))
      .map((c) => ({
        creator: c,
        tags: tagsByCreator.get(c.id) ?? [],
        followers: latestById.get(c.id)?.followers ?? null,
        videos: overviewById.get(c.id)?.videos_total ?? 0,
        views: overviewById.get(c.id)?.views_delta ?? 0,
        // null — прошлый срок ещё не приехал: ноль на его месте соврал бы про «−100%».
        viewsPrev: trend?.prev.get(c.id) ?? null,
        series: trend?.series.get(c.id),
      }));
  }, [data, statsData, localTags, platformFilter, trend]);

  function onTagChange(creatorId: string, tagId: string, on: boolean) {
    setLocalTags((prev) => {
      const without = prev.filter((ct) => !(ct.creator_id === creatorId && ct.tag_id === tagId));
      return on ? [...without, { creator_id: creatorId, tag_id: tagId }] : without;
    });
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (q) {
      list = list.filter(
        (r) =>
          r.creator.display_name.toLowerCase().includes(q) || r.creator.handle.toLowerCase().includes(q),
      );
    }
    if (selectedTags.size > 0) {
      list = list.filter((r) => {
        const own = new Set(r.tags.map((t) => t.id));
        for (const id of selectedTags) if (!own.has(id)) return false;
        return true;
      });
    }
    const sign = dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return (
            (a.creator.display_name || a.creator.handle).localeCompare(
              b.creator.display_name || b.creator.handle,
              t.lang,
            ) * sign
          );
        case "followers":
          return ((a.followers ?? 0) - (b.followers ?? 0)) * sign;
        case "videos":
          return (a.videos - b.videos) * sign;
        case "views":
          return (a.views - b.views) * sign;
        case "synced":
          return (
            ((a.creator.last_synced_at ? new Date(a.creator.last_synced_at).getTime() : 0) -
              (b.creator.last_synced_at ? new Date(b.creator.last_synced_at).getTime() : 0)) *
            sign
          );
      }
    });
    // t.lang в списке нарочно: сортировка по имени идёт по правилам выбранного языка.
  }, [rows, search, selectedTags, sortKey, dir, t.lang]);

  function onSort(k: Key) {
    const next = nextSort(sortKey, dir, k);
    setSortKey(next.key);
    setDir(next.dir);
  }

  function toggleTag(id: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Page
      title={t("creators.title")}
      subtitle={
        platformFilter === "all"
          ? profile.role === "admin"
            ? t("creators.subtitleAllAdmin")
            : t("creators.subtitleAllManager")
          : profile.role === "admin"
            ? t("creators.subtitleOnly", { platform: platformFilterLabel(platformFilter) })
            : t("creators.subtitleManagerPlatform", {
                platform: platformFilterLabel(platformFilter),
              })
      }
      actions={
        <>
          {/* Тот же выбор срока, что на дашборде и карточке креатора: стор один
              (`lib/dashboard-prefs.ts`), переход между страницами его не сбрасывает. */}
          <PeriodChip period={period} />
          <PlatformSwitch state={platform} />
          <ScopeSwitch scope={scope} onScope={setScope} />
          {data && <TagsDialog tags={data.tags} onChanged={reload} />}
          {profile.role === "admin" && <AddCreatorDialog onAdded={reload} />}
        </>
      }
    >
      {error ? (
        <PageError error={error} />
      ) : loading || !data ? (
        <PageSkeleton blocks={1} />
      ) : data ? (
        <Panel>
          <PanelHead
            title={t("creators.listTitle")}
            subtitle={
              <>
                {t("creators.countOf", {
                  shown: fmtNum(visible.length),
                  total: fmtNum(rows.length),
                })}
                {/* Молчать об этом нельзя: строки просто перестали бы показывать очередь. */}
                {queue.error && (
                  <span className="text-destructive" title={queue.error}>
                    {` · ${t("creators.queueUnreadable")}`}
                  </span>
                )}
                {trendError && (
                  <span className="text-destructive" title={trendError}>
                    {` · ${t("creators.trendUnreadable")}`}
                  </span>
                )}
              </>
            }
          >
            <div className="relative w-52">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("creators.searchPlaceholder")}
                className="h-8 pl-8 text-xs"
                aria-label={t("common.search")}
              />
            </div>
          </PanelHead>

          {data.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
              {data.tags.map((t) => (
                <TagPill
                  key={t.id}
                  name={t.name}
                  color={t.color}
                  active={selectedTags.has(t.id)}
                  onClick={() => toggleTag(t.id)}
                  size="xs"
                />
              ))}
              {selectedTags.size > 0 && (
                <Button variant="ghost" size="xs" onClick={() => setSelectedTags(new Set())}>
                  {t("common.reset")}
                </Button>
              )}
            </div>
          )}

          {visible.length === 0 ? (
            <Empty>
              {rows.length > 0
                ? t("creators.emptyFiltered")
                : platformFilter === "all"
                  ? t("creators.emptyNone")
                  : t("creators.emptyPlatform")}
            </Empty>
          ) : (
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <SortHead
                    k="name"
                    label={t("table.creator")}
                    sortKey={sortKey}
                    dir={dir}
                    onSort={onSort}
                    align="left"
                  />
                  <TableHead className="text-muted-foreground">{t("table.tags")}</TableHead>
                  {/* Галочка «все видео наши» — только показать (владелец, 2026-09-08: «пометка,
                      все ли данного креатора мы считаем своими, которую нельзя снимать»);
                      меняется она в карточке креатора. */}
                  <TableHead className="text-center text-muted-foreground">
                    {t("creators.allOursHead")}
                  </TableHead>
                  <SortHead k="followers" label={t("metric.followers")} sortKey={sortKey} dir={dir} onSort={onSort} />
                  <SortHead k="videos" label={t("metric.videos")} sortKey={sortKey} dir={dir} onSort={onSort} />
                  <SortHead
                    k="views"
                    label={
                      <span className="inline-flex flex-col items-end">
                        {t("creators.viewsPeriod")}
                        <span className="text-[11px] font-normal opacity-70">
                          {rangeCaption(period.range) ?? periodLabel(period.key)}
                        </span>
                      </span>
                    }
                    sortKey={sortKey}
                    dir={dir}
                    onSort={onSort}
                  />
                  <SortHead k="synced" label={t("table.updated")} sortKey={sortKey} dir={dir} onSort={onSort} />
                  <TableHead className="text-muted-foreground">{t("table.status")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => {
                  const name = r.creator.display_name || r.creator.handle;
                  return (
                    <TableRow key={r.creator.id}>
                      <TableCell>
                        <Link
                          href={`/creator/?id=${r.creator.id}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <Avatar src={r.creator.avatar_url} name={name} size={30} />
                          <CreatorLabel
                            platform={r.creator.platform}
                            name={r.creator.display_name}
                            handle={r.creator.handle}
                            className="font-medium"
                          />
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {r.tags.map((t) => (
                            <TagPill key={t.id} name={t.name} color={t.color} size="xs" />
                          ))}
                          <TagPicker
                            creatorId={r.creator.id}
                            tags={data.tags}
                            selected={new Set(r.tags.map((t) => t.id))}
                            onChange={(tagId, on) => onTagChange(r.creator.id, tagId, on)}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Checkbox
                          checked={r.creator.all_videos_ours}
                          disabled
                          aria-label={
                            r.creator.all_videos_ours
                              ? t("creators.allOursAria")
                              : t("creators.someOursAria")
                          }
                          title={
                            r.creator.all_videos_ours
                              ? t("creators.allOursTitle")
                              : t("creators.someOursTitle")
                          }
                          className="disabled:opacity-100 disabled:cursor-default"
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.followers)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.videos)}</TableCell>
                      {/* Столбец «За период»: число, дельта к прошлому сроку той же длины
                          и ход по дням — тот же спарклайн, что в плитках дашборда. */}
                      <TableCell className="text-right tabular-nums">
                        <div className="flex min-w-24 flex-col items-end gap-0.5">
                          <span>{fmtNum(r.views)}</span>
                          {r.viewsPrev !== null && (
                            <Delta
                              now={r.views}
                              prev={r.viewsPrev}
                              className="text-xs"
                              title={t("creators.vsPrevPeriod")}
                            />
                          )}
                          <Sparkline values={r.series} className="h-6 w-20" />
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        <LocalTime iso={r.creator.last_synced_at} mode="date" />
                      </TableCell>
                      <TableCell>
                        <Status creator={r.creator} />
                      </TableCell>
                      <TableCell>
                        {/* Одинаково у админа и у менеджера: RLS пускает просьбу за
                            креатора, которого человек видит. */}
                        <RowSyncButton
                          state={queue.rows.get(r.creator.id)}
                          onAsk={(depth, pick, maxVideos, range) =>
                            void queue.ask(r.creator.id, depth, pick, maxVideos, range)
                          }
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      ) : null}
    </Page>
  );
}

function Status({ creator }: { creator: Creator }) {
  const t = useT();
  if (creator.needs_reconnect) {
    return <span className="text-[var(--down)]">{t("creators.statusNeedsReconnect")}</span>;
  }
  if (creator.sync_error) {
    return (
      <span className="block max-w-[16rem] truncate text-[var(--down)]" title={creator.sync_error}>
        {creator.sync_error}
      </span>
    );
  }
  if (!creator.last_synced_at)
    return <span className="text-muted-foreground">{t("creators.statusNever")}</span>;
  return <span className="text-[var(--up)]">{t("creators.statusOk")}</span>;
}

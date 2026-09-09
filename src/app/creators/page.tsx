"use client";

import { useEffect, useMemo, useState } from "react";
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
import { fmtNum } from "@/lib/format";
import { useScope, type Scope } from "@/lib/dashboard-prefs";
import { useT } from "@/lib/i18n";
import { matchesPlatform, platformFilterLabel, usePlatformFilter } from "@/lib/platform-filter";
import { useLoader } from "@/lib/use-loader";
import { useSyncQueue } from "@/lib/use-sync-queue";
import { useProfile } from "@/lib/profile-context";
import type { PeriodRange } from "@/lib/period";
import type { Creator, CreatorLatest, CreatorOverview, CreatorTag, Tag } from "@/lib/types";

type Data = {
  creators: Creator[];
  tags: Tag[];
  creatorTags: CreatorTag[];
  latest: CreatorLatest[];
  overview: CreatorOverview[];
  // Срок, за который сосчитан `overview`: по нему же читаются ряды спарклайнов и прошлая
  // неделя — иначе колонка сравнивала бы числа за чуть разные сроки.
  range: PeriodRange;
};

// «за 7 дней» в списке — та же сводка, что на дашборде, но срок здесь один.
const WEEK_MS = 7 * 86_400_000;

// Спарклайн — это отдельный запрос на каждого креатора. До этого числа они читаются пачкой
// после списка, дальше столбец остаётся с одним числом и дельтой: сотня RPC ради рисунка
// в ячейке дороже самой страницы.
const SPARK_LIMIT = 30;

async function loadData(scope: Scope): Promise<Data> {
  const to = new Date();
  const from = new Date(to.getTime() - WEEK_MS);
  const [creators, tags, creatorTags, latest, overview] = await Promise.all([
    listCreators(),
    listTags(),
    listCreatorTags(),
    listCreatorLatest(),
    creatorsOverview({ from, to }, scope),
  ]);
  return { creators, tags, creatorTags, latest, overview, range: { from, to } };
}

// Дополнение к столбцу «за 7 дней»: прошлая неделя для дельты и дневные ряды для
// спарклайнов. Читается ПОСЛЕ таблицы и отдельно от неё — таблица показывается сразу,
// а рисунки и проценты появляются, когда приедут.
type Trend = { prev: Map<string, number>; series: Map<string, number[]> };

async function loadTrend(creators: Creator[], range: PeriodRange, scope: Scope): Promise<Trend> {
  const previous: PeriodRange = {
    from: new Date(range.from.getTime() - WEEK_MS),
    to: range.from,
  };
  const ids = creators.map((c) => c.id);
  const [prev, series] = await Promise.all([
    creatorsOverview(previous, scope),
    ids.length <= SPARK_LIMIT
      ? Promise.all(ids.map((id) => creatorDailyViews(id, range, scope)))
      : Promise.resolve(null),
  ]);
  return {
    prev: new Map(prev.map((o) => [o.creator_id, o.views_delta])),
    series: new Map(series ? ids.map((id, i) => [id, series[i].map((d) => d.views)]) : []),
  };
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
  // Оба переключателя те же, что на дашборде: положение общее через localStorage. Полосы
  // периода здесь нет — срок один, — поэтому охват стоит сегментом в шапке, рядом с площадкой.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;
  const { scope, setScope } = useScope();
  // Охват уходит в базу (миграция v22): и столбец «За 7 дней», и спарклайны считаются по
  // сужённому набору видео, поэтому смена охвата перечитывает страницу.
  const { data, error, loading, reload } = useLoader(() => loadData(scope), [scope]);
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<Key>("views");
  const [dir, setDir] = useState<SortDir>("desc");

  // Очередь обновления — одна на таблицу. Список креаторов для неё берётся весь, до фильтра
  // площадки и поиска: иначе просьба переставала бы отслеживаться, стоило спрятать строку.
  const queueIds = useMemo(() => data?.creators.map((c) => c.id) ?? [], [data]);
  const queue = useSyncQueue(queueIds, reload);

  // Тренд столбца «за 7 дней» — вторым заходом, уже после списка: пока он едет, таблица
  // стоит и работает, просто без спарклайнов и процентов.
  const [trend, setTrend] = useState<Trend | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    let alive = true;
    loadTrend(data.creators, data.range, scope).then(
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
  }, [data, scope]);

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
    const overviewById = new Map(data.overview.map((o) => [o.creator_id, o]));
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
        // null — прошлая неделя ещё не приехала: ноль на её месте соврал бы про «−100%».
        viewsPrev: trend?.prev.get(c.id) ?? null,
        series: trend?.series.get(c.id),
      }));
  }, [data, localTags, platformFilter, trend]);

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
          <PlatformSwitch state={platform} />
          <ScopeSwitch scope={scope} onScope={setScope} />
          {data && <TagsDialog tags={data.tags} onChanged={reload} />}
          {profile.role === "admin" && <AddCreatorDialog onAdded={reload} />}
        </>
      }
    >
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
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
                  <SortHead k="views" label={t("creators.views7d")} sortKey={sortKey} dir={dir} onSort={onSort} />
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
                      {/* Столбец «за 7 дней»: число, дельта к прошлой семёрке и её ход
                          по дням — тот же спарклайн, что в плитках дашборда. */}
                      <TableCell className="text-right tabular-nums">
                        <div className="flex min-w-24 flex-col items-end gap-0.5">
                          <span>{fmtNum(r.views)}</span>
                          {r.viewsPrev !== null && (
                            <Delta
                              now={r.views}
                              prev={r.viewsPrev}
                              className="text-xs"
                              title={t("creators.vsPrevWeek")}
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

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { Avatar } from "@/components/avatar";
import { PlatformSwitch } from "@/components/platform-switch";
import { TagPill } from "@/components/tag-pill";
import { LocalTime } from "@/components/local-time";
import { TagPicker } from "@/components/creators/tag-picker";
import { TagsDialog } from "@/components/creators/tags-dialog";
import { AddCreatorDialog } from "@/components/creators/add-creator-dialog";
import { RowSyncButton } from "@/components/creators/row-sync-button";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { SortHead, nextSort, type SortDir } from "@/components/stats/sort-head";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  creatorsOverview,
  listCreatorLatest,
  listCreatorTags,
  listCreators,
  listTags,
} from "@/lib/queries";
import { fmtNum } from "@/lib/format";
import { matchesPlatform, PLATFORM_FILTER_LABELS, usePlatformFilter } from "@/lib/platform-filter";
import { useLoader } from "@/lib/use-loader";
import { useSyncQueue } from "@/lib/use-sync-queue";
import { useProfile } from "@/lib/profile-context";
import type { Creator, CreatorLatest, CreatorOverview, CreatorTag, Tag } from "@/lib/types";

type Data = {
  creators: Creator[];
  tags: Tag[];
  creatorTags: CreatorTag[];
  latest: CreatorLatest[];
  overview: CreatorOverview[];
};

// «Просмотры за 7 дней» в списке — та же сводка, что на дашборде, но срок здесь один.
const WEEK_MS = 7 * 86_400_000;

async function loadData(): Promise<Data> {
  const to = new Date();
  const from = new Date(to.getTime() - WEEK_MS);
  const [creators, tags, creatorTags, latest, overview] = await Promise.all([
    listCreators(),
    listTags(),
    listCreatorTags(),
    listCreatorLatest(),
    creatorsOverview({ from, to }),
  ]);
  return { creators, tags, creatorTags, latest, overview };
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
  const profile = useProfile();
  const { data, error, loading, reload } = useLoader(loadData, []);
  // Переключатель тот же, что на дашборде: положение общее через localStorage.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<Key>("views");
  const [dir, setDir] = useState<SortDir>("desc");

  // Очередь обновления — одна на таблицу. Список креаторов для неё берётся весь, до фильтра
  // площадки и поиска: иначе просьба переставала бы отслеживаться, стоило спрятать строку.
  const queueIds = useMemo(() => data?.creators.map((c) => c.id) ?? [], [data]);
  const queue = useSyncQueue(queueIds, reload);

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
      }));
  }, [data, localTags, platformFilter]);

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
              "ru",
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
  }, [rows, search, selectedTags, sortKey, dir]);

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
      title="Креаторы"
      subtitle={
        platformFilter === "all"
          ? profile.role === "admin"
            ? "Все креаторы"
            : "Привязанные к вам креаторы"
          : profile.role === "admin"
            ? `Только ${PLATFORM_FILTER_LABELS[platformFilter]}`
            : `Привязанные к вам креаторы · ${PLATFORM_FILTER_LABELS[platformFilter]}`
      }
      actions={
        <>
          <PlatformSwitch state={platform} />
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
            title="Список"
            subtitle={
              <>
                {fmtNum(visible.length)} из {fmtNum(rows.length)}
                {/* Молчать об этом нельзя: строки просто перестали бы показывать очередь. */}
                {queue.error && (
                  <span className="text-destructive" title={queue.error}>
                    {" "}
                    · очередь обновления не читается
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
                placeholder="Поиск по имени или @имени"
                className="h-8 pl-8 text-xs"
                aria-label="Поиск"
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
                  Сбросить
                </Button>
              )}
            </div>
          )}

          {visible.length === 0 ? (
            <Empty>
              {rows.length > 0
                ? "Никто не подходит под поиск и фильтр."
                : platformFilter === "all"
                  ? "Креаторов пока нет."
                  : "На этой площадке креаторов нет."}
            </Empty>
          ) : (
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <SortHead k="name" label="Креатор" sortKey={sortKey} dir={dir} onSort={onSort} align="left" />
                  <TableHead className="text-muted-foreground">Теги</TableHead>
                  {/* Галочка «все видео наши» — только показать (владелец, 2026-09-08: «пометка,
                      все ли данного креатора мы считаем своими, которую нельзя снимать»);
                      меняется она в карточке креатора. */}
                  <TableHead className="text-center text-muted-foreground">Все наши</TableHead>
                  <SortHead k="followers" label="Подписчики" sortKey={sortKey} dir={dir} onSort={onSort} />
                  <SortHead k="videos" label="Видео" sortKey={sortKey} dir={dir} onSort={onSort} />
                  <SortHead k="views" label="Просмотры за 7 дней" sortKey={sortKey} dir={dir} onSort={onSort} />
                  <SortHead k="synced" label="Обновлено" sortKey={sortKey} dir={dir} onSort={onSort} />
                  <TableHead className="text-muted-foreground">Состояние</TableHead>
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
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              @{r.creator.handle}
                            </span>
                          </span>
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
                          aria-label={r.creator.all_videos_ours ? "Все видео наши" : "Наши только помеченные видео"}
                          title={
                            r.creator.all_videos_ours
                              ? "Все видео креатора считаются нашими"
                              : "Наши только помеченные видео — меняется в карточке креатора"
                          }
                          className="disabled:opacity-100 disabled:cursor-default"
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.followers)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.videos)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.views)}</TableCell>
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
                          creatorId={r.creator.id}
                          state={queue.rows.get(r.creator.id)}
                          onAsk={(depth, pick) => void queue.ask(r.creator.id, depth, pick)}
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
  if (creator.needs_reconnect) {
    return <span className="text-[var(--down)]">нужно переподключить</span>;
  }
  if (creator.sync_error) {
    return (
      <span className="block max-w-[16rem] truncate text-[var(--down)]" title={creator.sync_error}>
        {creator.sync_error}
      </span>
    );
  }
  if (!creator.last_synced_at) return <span className="text-muted-foreground">ещё не обновлялся</span>;
  return <span className="text-[var(--up)]">в порядке</span>;
}

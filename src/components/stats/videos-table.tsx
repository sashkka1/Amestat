"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Cover } from "@/components/cover";
import { PlatformIcon } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { VideoStateToggle } from "@/components/video-state-toggle";
import { Panel, PanelHead, Empty } from "./panel";
import { SortHead, nextSort, type SortDir } from "./sort-head";
import { engagementPct, fmtDayAxis, fmtNum } from "@/lib/format";
import { useT, type TKey } from "@/lib/i18n";
import { STATE_ROW_CLASS, type VideoState } from "@/lib/video-state";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

export type VideoTableRow = {
  id: string;
  creatorId: string;
  creatorName: string;
  handle: string;
  platform: Platform;
  avatarUrl: string | null;
  caption: string;
  coverUrl: string | null;
  url: string;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  // Три состояния вместо прежнего «наше / не наше» (миграция v17) — `lib/video-state.ts`.
  state: VideoState;
};

type Key = "views" | "likes" | "comments" | "shares" | "saves" | "engagement" | "published";

// Чипы фильтра по состоянию. Слова во множественном числе — это про набор строк, а не про
// одно видео, поэтому свои, а не stateLabel: «Наши», а не «Наше».
type StateFilter = VideoState | "all";
const FILTER_KEYS: StateFilter[] = ["all", "ours", "watch", "none"];
const FILTER_LABELS: Record<StateFilter, TKey> = {
  all: "videosTable.filterAll",
  ours: "videosTable.filterOurs",
  watch: "videosTable.filterWatch",
  none: "videosTable.filterNone",
};

const PAGE = 20;

function value(r: VideoTableRow, k: Key): number {
  switch (k) {
    case "published":
      return r.publishedAt ? new Date(r.publishedAt).getTime() : 0;
    case "engagement":
      return r.views ? (r.likes + r.comments + r.shares) / r.views : 0;
    default:
      return r[k];
  }
}

// Таблица видео: и «Новые видео» на дашборде, и полный список у креатора.
export function VideosTable({
  rows,
  title,
  showCreator = true,
  defaultSort = "published",
  onSetState,
  onRowClick,
  selectedId,
}: {
  rows: VideoTableRow[];
  title?: string;
  showCreator?: boolean;
  defaultSort?: Key;
  // Задан — появляется колонка «Состояние» с переключателем «не наше / смотрим / наше».
  onSetState?: (videoId: string, state: VideoState) => void;
  onRowClick?: (videoId: string) => void;
  selectedId?: string | null;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  // Фильтр по состоянию живёт только в таблице и нигде не сохраняется: это взгляд на список
  // сейчас, а не настройка страницы.
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [sortKey, setSortKey] = useState<Key>(defaultSort);
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byState = stateFilter === "all" ? rows : rows.filter((r) => r.state === stateFilter);
    if (!q) return byState;
    return byState.filter(
      (r) =>
        r.caption.toLowerCase().includes(q) ||
        r.creatorName.toLowerCase().includes(q) ||
        r.handle.toLowerCase().includes(q),
    );
  }, [rows, search, stateFilter]);

  const sorted = useMemo(() => {
    const sign = dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => (value(a, sortKey) - value(b, sortKey)) * sign);
  }, [filtered, sortKey, dir]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = sorted.slice(current * PAGE, current * PAGE + PAGE);

  function onSort(k: Key) {
    const next = nextSort(sortKey, dir, k);
    setSortKey(next.key);
    setDir(next.dir);
    setPage(0);
  }

  return (
    <Panel>
      <PanelHead
        title={title ?? t("videosTable.title")}
        subtitle={t("videosTable.count", {
          n: fmtNum(filtered.length),
          videos: t.plural("videos", filtered.length),
        })}
      >
        {/* Чипы состояния — рядом с поиском: тот же ряд управления таблицей. */}
        <div className="flex flex-wrap items-center gap-1">
          {FILTER_KEYS.map((key) => (
            <Button
              key={key}
              type="button"
              size="xs"
              variant={stateFilter === key ? "secondary" : "outline"}
              aria-pressed={stateFilter === key}
              onClick={() => {
                setStateFilter(key);
                setPage(0);
              }}
            >
              {t(FILTER_LABELS[key])}
            </Button>
          ))}
        </div>
        <div className="relative w-52">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder={t("videosTable.searchPlaceholder")}
            className="h-8 pl-8 text-xs"
            aria-label={t("videosTable.searchAria")}
          />
        </div>
      </PanelHead>

      {shown.length === 0 ? (
        <Empty>{t("videosTable.empty")}</Empty>
      ) : (
        <>
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                {showCreator && (
                  <TableHead className="text-muted-foreground">{t("table.creator")}</TableHead>
                )}
                <TableHead className="text-muted-foreground">{t("metric.videos")}</TableHead>
                <SortHead k="views" label={t("metric.views")} sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="likes" label={t("metric.likes")} sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="comments" label={t("metric.comments")} sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="shares" label={t("metric.shares")} sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="saves" label={t("metric.saves")} sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="engagement" label={t("videosTable.engagementShort")} sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="published" label={t("table.date")} sortKey={sortKey} dir={dir} onSort={onSort} />
                {onSetState && (
                  <TableHead className="text-center text-muted-foreground">{t("table.status")}</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow
                  key={r.id}
                  onClick={onRowClick ? () => onRowClick(r.id) : undefined}
                  data-state={r.id === selectedId ? "selected" : undefined}
                  className={cn(onRowClick && "cursor-pointer", STATE_ROW_CLASS[r.state])}
                >
                  {showCreator && (
                    <TableCell>
                      <Link
                        href={`/creator/?id=${r.creatorId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <Avatar src={r.avatarUrl} name={r.creatorName} size={24} />
                        <span className="max-w-[10rem] truncate">{r.creatorName}</span>
                      </Link>
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Cover src={r.coverUrl} width={28} />
                      <PlatformIcon platform={r.platform} />
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="max-w-[18rem] truncate hover:underline"
                        title={r.caption}
                      >
                        {r.caption || t("common.noCaption")}
                      </a>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.views)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.likes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.comments)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.shares)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.saves)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {engagementPct(r.likes, r.comments, r.shares, r.views)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.publishedAt ? fmtDayAxis(r.publishedAt) : "—"}
                  </TableCell>
                  {onSetState && (
                    <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                      <VideoStateToggle state={r.state} onChange={(next) => onSetState(r.id, next)} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {pages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
              <span>{t("videosTable.page", { current: current + 1, total: pages })}</span>
              <div className="flex gap-1">
                <Button size="xs" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  {t("common.back")}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={current >= pages - 1}
                  onClick={() => setPage(current + 1)}
                >
                  {t("common.forward")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

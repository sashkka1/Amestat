"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Cover } from "@/components/cover";
import { PlatformIcon } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel, PanelHead, Empty } from "./panel";
import { SortHead, nextSort, type SortDir } from "./sort-head";
import { engagementPct, fmtDayAxis, fmtNum } from "@/lib/format";
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
  ours: boolean;
};

type Key = "views" | "likes" | "comments" | "shares" | "saves" | "engagement" | "published";

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
  title = "Видео",
  showCreator = true,
  defaultSort = "published",
  onToggleOurs,
  onRowClick,
  selectedId,
}: {
  rows: VideoTableRow[];
  title?: string;
  showCreator?: boolean;
  defaultSort?: Key;
  // Задан — появляется колонка «Наше» с переключателем.
  onToggleOurs?: (videoId: string, on: boolean) => void;
  onRowClick?: (videoId: string) => void;
  selectedId?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<Key>(defaultSort);
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.caption.toLowerCase().includes(q) ||
        r.creatorName.toLowerCase().includes(q) ||
        r.handle.toLowerCase().includes(q),
    );
  }, [rows, search]);

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
      <PanelHead title={title} subtitle={`${fmtNum(filtered.length)} видео`}>
        <div className="relative w-52">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Поиск по подписи"
            className="h-8 pl-8 text-xs"
            aria-label="Поиск по видео"
          />
        </div>
      </PanelHead>

      {shown.length === 0 ? (
        <Empty>Видео нет.</Empty>
      ) : (
        <>
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                {showCreator && <TableHead className="text-muted-foreground">Креатор</TableHead>}
                <TableHead className="text-muted-foreground">Видео</TableHead>
                <SortHead k="views" label="Просмотры" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="likes" label="Лайки" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="comments" label="Комментарии" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="shares" label="Репосты" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="saves" label="Сохранения" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="engagement" label="Вовл. %" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortHead k="published" label="Дата" sortKey={sortKey} dir={dir} onSort={onSort} />
                {onToggleOurs && <TableHead className="text-center text-muted-foreground">Наше</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow
                  key={r.id}
                  onClick={onRowClick ? () => onRowClick(r.id) : undefined}
                  data-state={r.id === selectedId ? "selected" : undefined}
                  className={cn(
                    onRowClick && "cursor-pointer",
                    !r.ours && "text-muted-foreground opacity-60",
                  )}
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
                        {r.caption || "без подписи"}
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
                  {onToggleOurs && (
                    <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={r.ours}
                        onCheckedChange={(v) => onToggleOurs(r.id, v === true)}
                        aria-label="Наше видео"
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {pages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
              <span>
                Страница {current + 1} из {pages}
              </span>
              <div className="flex gap-1">
                <Button size="xs" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  Назад
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={current >= pages - 1}
                  onClick={() => setPage(current + 1)}
                >
                  Вперёд
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

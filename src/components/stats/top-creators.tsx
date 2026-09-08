"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { PlatformChip } from "@/components/platform";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel, PanelHead, Empty } from "./panel";
import { SortHead, nextSort, type SortDir } from "./sort-head";
import { fmtNum } from "@/lib/format";
import type { Creator, CreatorOverview } from "@/lib/types";

export type CreatorRow = {
  creator: Creator;
  views: number;
  engagement: number;
  videos: number;
  avgViews: number;
};

type Key = "views" | "engagement" | "videos" | "avgViews";

export function buildCreatorRows(creators: Creator[], overview: CreatorOverview[]): CreatorRow[] {
  const byId = new Map(overview.map((o) => [o.creator_id, o]));
  return creators.map((c) => {
    const o = byId.get(c.id);
    const views = o?.views_delta ?? 0;
    const videos = o?.videos_total ?? 0;
    return {
      creator: c,
      views,
      engagement: (o?.likes_delta ?? 0) + (o?.comments_delta ?? 0) + (o?.shares_delta ?? 0),
      videos,
      avgViews: videos > 0 ? Math.round(views / videos) : 0,
    };
  });
}

// «Лучшие креаторы» за срок. Ранг — место в текущей сортировке.
export function TopCreators({ rows, limit }: { rows: CreatorRow[]; limit?: number }) {
  const [sortKey, setSortKey] = useState<Key>("views");
  const [dir, setDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const sign = dir === "asc" ? 1 : -1;
    const list = [...rows].sort((a, b) => (a[sortKey] - b[sortKey]) * sign);
    return limit ? list.slice(0, limit) : list;
  }, [rows, sortKey, dir, limit]);

  function onSort(k: Key) {
    const next = nextSort(sortKey, dir, k);
    setSortKey(next.key);
    setDir(next.dir);
  }

  return (
    <Panel>
      <PanelHead title="Лучшие креаторы" subtitle={`Все креаторы: ${rows.length}`} />
      {sorted.length === 0 ? (
        <Empty>Креаторов пока нет.</Empty>
      ) : (
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-muted-foreground">Ранг</TableHead>
              <TableHead className="text-muted-foreground">Креатор</TableHead>
              <TableHead className="text-muted-foreground">Платформа</TableHead>
              <SortHead k="views" label="Просмотры" sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="engagement" label="Вовлечённость" sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="videos" label="Видео" sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="avgViews" label="Ср. просмотров/видео" sortKey={sortKey} dir={dir} onSort={onSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r, i) => {
              const name = r.creator.display_name || r.creator.handle;
              return (
                <TableRow key={r.creator.id}>
                  <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell>
                    <Link
                      href={`/creator/?id=${r.creator.id}`}
                      className="flex items-center gap-2 hover:underline"
                    >
                      <Avatar src={r.creator.avatar_url} name={name} size={28} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          @{r.creator.handle}
                        </span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <PlatformChip platform={r.creator.platform} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.views)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.engagement)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.videos)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.avgViews)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

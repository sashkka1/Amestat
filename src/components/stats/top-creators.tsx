"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { PlatformChip } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Delta } from "./delta";
import { Panel, PanelHead, Empty } from "./panel";
import { SortHead, nextSort, type SortDir } from "./sort-head";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Creator, CreatorOverview } from "@/lib/types";

export type CreatorRow = {
  creator: Creator;
  views: number;
  engagement: number;
  // Сколько роликов вышло за срок (`videos_published`), а не сколько их всего у креатора:
  // строка — про этот срок целиком, и среднее считается по этому же числу.
  videos: number;
  avgViews: number;
  // Просмотры за прошлый срок той же длины; 0 — сравнивать не с чем, в колонке будет «—».
  viewsPrev: number;
};

type Key = "views" | "engagement" | "videos" | "avgViews" | "delta";

// Сколько строк видно до нажатия «Показать все»: таблица на дашборде — витрина лидеров,
// а не полный список.
const COLLAPSED = 5;

// Сортировка по дельте — по доле, а не по разнице в штуках: иначе колонка с процентами
// упорядочивалась бы не по тому, что в ней написано.
function value(r: CreatorRow, k: Key): number {
  if (k !== "delta") return r[k];
  return r.viewsPrev === 0 ? 0 : (r.views - r.viewsPrev) / r.viewsPrev;
}

// `prev` — ряды creators_overview за прошлый срок; их считает страница вторым вызовом того
// же RPC, ровно как для плиток. Не переданы — колонка дельты покажет «—».
export function buildCreatorRows(
  creators: Creator[],
  overview: CreatorOverview[],
  prev: CreatorOverview[] = [],
): CreatorRow[] {
  const byId = new Map(overview.map((o) => [o.creator_id, o]));
  const prevById = new Map(prev.map((o) => [o.creator_id, o]));
  return creators.map((c) => {
    const o = byId.get(c.id);
    const views = o?.views_delta ?? 0;
    const videos = o?.videos_published ?? 0;
    return {
      creator: c,
      views,
      engagement: (o?.likes_delta ?? 0) + (o?.comments_delta ?? 0) + (o?.shares_delta ?? 0),
      videos,
      avgViews: videos > 0 ? Math.round(views / videos) : 0,
      viewsPrev: prevById.get(c.id)?.views_delta ?? 0,
    };
  });
}

// «Лучшие креаторы» за срок. Ранг — место в текущей сортировке.
// countLabel — что именно сосчитано в подписи: при фильтре площадки это уже не «все».
export function TopCreators({
  rows,
  countLabel,
  collapseKey,
}: {
  rows: CreatorRow[];
  countLabel?: string;
  collapseKey?: string;
}) {
  const t = useT();
  const [sortKey, setSortKey] = useState<Key>("views");
  const [dir, setDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => (value(a, sortKey) - value(b, sortKey)) * sign);
  }, [rows, sortKey, dir]);
  const shown = expanded ? sorted : sorted.slice(0, COLLAPSED);

  function onSort(k: Key) {
    const next = nextSort(sortKey, dir, k);
    setSortKey(next.key);
    setDir(next.dir);
  }

  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead
        title={t("topCreators.title")}
        subtitle={`${countLabel ?? t("topCreators.countAll")}: ${rows.length}`}
      />
      {sorted.length === 0 ? (
        <Empty>{t("topCreators.empty")}</Empty>
      ) : (
        <>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-muted-foreground">{t("topCreators.rank")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.creator")}</TableHead>
              <TableHead className="text-muted-foreground">{t("topCreators.platform")}</TableHead>
              <SortHead k="views" label={t("metric.views")} sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="engagement" label={t("metric.engagement")} sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="videos" label={t("topCreators.published")} sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="avgViews" label={t("topCreators.avgViews")} sortKey={sortKey} dir={dir} onSort={onSort} />
              <SortHead k="delta" label={t("topCreators.deltaViews")} sortKey={sortKey} dir={dir} onSort={onSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r, i) => {
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
                  <TableCell className="text-right font-medium tabular-nums">{fmtNum(r.views)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.engagement)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.videos)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(r.avgViews)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Delta now={r.views} prev={r.viewsPrev} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {sorted.length > COLLAPSED && (
          <div className="border-t px-4 py-2 text-center">
            <Button size="xs" variant="outline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? t("topCreators.showLess") : t("topCreators.showAll", { n: sorted.length })}
            </Button>
          </div>
        )}
        </>
      )}
    </Panel>
  );
}

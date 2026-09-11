"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { CreatorLabel } from "@/components/creator-label";
import { PlatformChip } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Delta } from "./delta";
import { Panel, PanelHead, Empty } from "./panel";
import { SortHead, nextSort, type SortDir } from "./sort-head";
import { fmtNum } from "@/lib/format";
import { engagementOf } from "@/lib/stats";
import { useT } from "@/lib/i18n";
import type { CrossCreator } from "@/lib/cross";
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
  // Перекрёстность за срок (миграция v29): сколько написал другим нашим и сколько получил
  // от них. Задана только на странице «Amestat Test» — на дашборде колонки нет вовсе.
  cross?: CrossCreator;
};

type Key = "views" | "engagement" | "videos" | "avgViews" | "delta" | "cross";

// Сколько строк видно до нажатия «Показать все»: таблица на дашборде — витрина лидеров,
// а не полный список.
const COLLAPSED = 5;

// Сортировка по дельте — по доле, а не по разнице в штуках: иначе колонка с процентами
// упорядочивалась бы не по тому, что в ней написано.
function value(r: CreatorRow, k: Key): number {
  // Сортировка по перекрёстности — по полученным: столбец про то, кого комментируют.
  if (k === "cross") return r.cross?.received ?? 0;
  if (k !== "delta") return r[k];
  return r.viewsPrev === 0 ? 0 : (r.views - r.viewsPrev) / r.viewsPrev;
}

// `prev` — ряды creators_overview за прошлый срок; их считает страница вторым вызовом того
// же RPC, ровно как для плиток. Не переданы — колонка дельты покажет «—».
export function buildCreatorRows(
  creators: Creator[],
  overview: CreatorOverview[],
  prev: CreatorOverview[] = [],
  // Перекрёстность по креатору; не передана — колонки «Перекрёстно» в таблице нет.
  cross?: Map<string, CrossCreator>,
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
      // Та же формула, что у плитки «Вовлечённость» над таблицей (`lib/stats.ts`).
      engagement: engagementOf({
        likes: o?.likes_delta,
        comments: o?.comments_delta,
        shares: o?.shares_delta,
      }),
      videos,
      avgViews: videos > 0 ? Math.round(views / videos) : 0,
      viewsPrev: prevById.get(c.id)?.views_delta ?? 0,
      // Ноль ставим сами: у креатора без единого пересечения строка обязана показать «0»,
      // а не «колонки нет» — колонка решается наличием самой карты, а не этой строки.
      cross: cross ? (cross.get(c.id) ?? { given: 0, received: 0 }) : undefined,
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
  // Колонку решает наличие данных, а не отдельный флаг: строки строит `buildCreatorRows`,
  // и передавший ей перекрёстность заведомо хочет её видеть.
  const showCross = rows.some((r) => r.cross !== undefined);

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
              {showCross && (
                <SortHead k="cross" label={t("cross.column")} sortKey={sortKey} dir={dir} onSort={onSort} />
              )}
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
                      <CreatorLabel
                        platform={r.creator.platform}
                        name={r.creator.display_name}
                        handle={r.creator.handle}
                        className="font-medium"
                      />
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
                  {showCross && (
                    <TableCell
                      className="text-right tabular-nums"
                      title={t("cross.creatorCell", {
                        handle: `@${r.creator.handle}`,
                        received: fmtNum(r.cross?.received ?? 0),
                        given: fmtNum(r.cross?.given ?? 0),
                      })}
                    >
                      {/* Подсказка у самой клетки — она говорит про обе стороны сразу,
                          поэтому число здесь без своего `title`. */}
                      {(r.cross?.received ?? 0) > 0 ? (
                        <span className="font-medium text-amber-600 dark:text-amber-500">
                          {fmtNum(r.cross?.received ?? 0)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </TableCell>
                  )}
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

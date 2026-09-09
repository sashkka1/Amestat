"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { Cover } from "@/components/cover";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel } from "@/components/stats/panel";
import { VideoStateToggle } from "@/components/video-state-toggle";
import { VideoHistoryChart } from "./daily-chart";
import { VideoComments } from "./video-comments";
import { videoHistory } from "@/lib/queries";
import { describeVsMedian } from "@/lib/stats";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { useT, type TKey } from "@/lib/i18n";
import type { VideoState } from "@/lib/video-state";
import type { Platform, VideoStats } from "@/lib/types";

export const PANEL_METRICS = [
  { key: "views", label: "metric.views" },
  { key: "likes", label: "metric.likes" },
  { key: "comments", label: "metric.comments" },
  { key: "shares", label: "metric.shares" },
  { key: "saves", label: "metric.saves" },
] as const satisfies readonly { key: string; label: TKey }[];
export type MetricKey = (typeof PANEL_METRICS)[number]["key"];

// Выбранное видео: сравнение с медианой креатора за срок и своя история по снимкам.
export function VideoPanel({
  row,
  state,
  onState,
  medians,
  platform,
  refreshKey,
  onClose,
}: {
  row: VideoStats;
  // Состояние видео и его переключатель — те же, что в строке таблицы: `videos.ours` из
  // самой строки, `videos.watch` карточка креатора дочитывает отдельно (миграция v17).
  state: VideoState;
  onState: (next: VideoState) => void;
  medians: Record<MetricKey, number | null>;
  // Площадка креатора: по ней строятся ссылки на авторов комментариев.
  platform: Platform;
  // Меняется после обхода — комментарии и история по снимкам перечитываются.
  refreshKey: number;
  onClose: () => void;
}) {
  const t = useT();
  // История помнит, чьё она видео: сменилась строка — до ответа показываем скелет.
  const [loaded, setLoaded] = useState<{
    videoId: string;
    data: { t: string; views: number }[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    const videoId = row.video_id;
    videoHistory(videoId).then(
      (data) => {
        if (alive) setLoaded({ videoId, data, error: null });
      },
      (e: unknown) => {
        if (alive) setLoaded({ videoId, data: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
    // refreshKey в списке нарочно: после обхода у видео появился новый снимок, график должен его увидеть.
  }, [row.video_id, refreshKey]);

  const current = loaded?.videoId === row.video_id ? loaded : null;

  return (
    <Panel className="flex flex-col gap-4 p-4">
      <div className="flex gap-4">
        <Cover src={row.cover_url} width={56} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{row.caption || t("common.noCaption")}</p>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <XIcon />
            </Button>
          </div>
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {t("videoPanel.openOnPlatform")}
            <ExternalLinkIcon className="size-3" />
          </a>
          <p className="text-xs text-muted-foreground">
            {t("videoPanel.published", { date: fmtDateTime(row.published_at) })}
          </p>
          <VideoStateToggle state={state} onChange={onState} withLabels className="self-start" />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("videoPanel.vsMedian")}</h3>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="text-muted-foreground">{t("videoPanel.counter")}</TableHead>
              <TableHead className="text-right text-muted-foreground">{t("videoPanel.thisVideo")}</TableHead>
              <TableHead className="text-right text-muted-foreground">{t("videoPanel.median")}</TableHead>
              <TableHead className="text-right text-muted-foreground">{t("videoPanel.result")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PANEL_METRICS.map((m) => {
              const value = row[`${m.key}_delta`];
              const now = row[`${m.key}_now`];
              return (
                <TableRow key={m.key}>
                  <TableCell>{t(m.label)}</TableCell>
                  {/* Одно число — текущее значение счётчика (владелец, 2026-09-09).
                      Прирост за срок из колонки убран: он остаётся в расчёте справа,
                      где сравнивается с медианой, но глазами тут нужен итог. */}
                  <TableCell className="text-right tabular-nums">{fmtNum(now)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(medians[m.key])}</TableCell>
                  <TableCell className="text-right">{describeVsMedian(value, medians[m.key])}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          {t("videoPanel.viewsBySnapshots")}
        </h3>
        {current?.error ? (
          <p className="text-xs text-destructive">
            {t("videoPanel.snapshotsError", { error: current.error })}
          </p>
        ) : current?.data ? (
          <VideoHistoryChart data={current.data} />
        ) : (
          <Skeleton className="h-36 w-full" />
        )}
      </div>

      {/* Список длинный — стоит последним, чтобы график не уезжал за экран. */}
      <VideoComments
        videoId={row.video_id}
        platform={platform}
        total={row.comments_now}
        ours={row.ours}
        refreshKey={refreshKey}
      />
    </Panel>
  );
}

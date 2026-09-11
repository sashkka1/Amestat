"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { Cover } from "@/components/cover";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel } from "@/components/stats/panel";
import { VideoStateToggle } from "@/components/video-state-toggle";
import { CrossBadge, MentionMark } from "@/components/stats/cross-badge";
import { VideoHistoryChart } from "./daily-chart";
import { VideoComments, type OursMark } from "./video-comments";
import { videoHistory } from "@/lib/queries";
import type { CrossInfo } from "@/lib/cross";
import { describeVsMedian, median } from "@/lib/stats";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { useT, type TKey } from "@/lib/i18n";
import { publishedIn } from "@/lib/video-rows";
import type { PeriodRange } from "@/lib/period";
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

// Видео, которые за срок вышли или что-то набрали: только по ним считается медиана креатора.
// 🔴 Отбор и сама медиана живут здесь одни на весь сайт: их считает и карточка креатора, и
// шторка дашборда, а разъехавшись, они показали бы у одного видео две разные «нормы».
export function activeRows(rows: VideoStats[], range: PeriodRange): VideoStats[] {
  return rows.filter((r) => r.views_delta > 0 || publishedIn(r.published_at, range));
}

export function panelMedians(active: VideoStats[]): Record<MetricKey, number | null> {
  return Object.fromEntries(
    PANEL_METRICS.map((m) => [m.key, median(active.map((r) => r[`${m.key}_delta`]))]),
  ) as Record<MetricKey, number | null>;
}

// Выбранное видео: сравнение с медианой креатора за срок и своя история по снимкам.
//
// Панель одна на два места (владелец, 2026-09-09): на карточке креатора она встроена
// в страницу карточкой, на дашборде — тем же содержимым внутри выдвижной шторки. Отсюда
// два необязательных свойства: `plain` убирает собственную рамку (её даёт шторка), а без
// `onClose` не рисуется крестик — в шторке он свой, в её шапке.
export function VideoPanel({
  row,
  state,
  onState,
  medians,
  platform,
  refreshKey,
  onClose,
  plain = false,
  note,
  cross,
  mark,
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
  // Не задан — крестика нет: закрытием ведает хозяин (шапка шторки).
  onClose?: () => void;
  // Рамку и отступ даёт хозяин, а не сама панель.
  plain?: boolean;
  // Строка под ссылкой на площадку: шторка дашборда говорит ею, что за срок снимков не было
  // и счётчики показаны текущие.
  note?: string | null;
  // Перекрёстность этого видео (страница «Amestat Test»): жёлтое «(N)» у строки
  // «Комментарии» и значок «@», если наш креатор назван в подписи. Не задана — панель
  // прежняя, как на дашборде и карточке креатора.
  cross?: CrossInfo;
  // Подсветка комментариев наших креаторов в списке ниже.
  mark?: OursMark;
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

  const body = (
    <>
      <div className="flex gap-4">
        <Cover src={row.cover_url} width={56} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{row.caption || t("common.noCaption")}</p>
            {onClose && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                title={t("common.close")}
                aria-label={t("common.close")}
              >
                <XIcon />
              </Button>
            )}
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
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {cross && cross.mentions.length > 0 && (
            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
              <MentionMark handles={cross.mentions} />
              {t("cross.mentionLine", { handles: cross.mentions.map((h) => `@${h}`).join(", ") })}
            </p>
          )}
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
                  <TableCell className="text-right tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      {fmtNum(now)}
                      {m.key === "comments" && (
                        <CrossBadge n={cross?.cross ?? 0} handles={cross?.handles ?? []} />
                      )}
                    </span>
                  </TableCell>
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
        mark={mark}
      />
    </>
  );

  if (plain) return <div className="flex flex-col gap-4">{body}</div>;
  return <Panel className="flex flex-col gap-4 p-4">{body}</Panel>;
}

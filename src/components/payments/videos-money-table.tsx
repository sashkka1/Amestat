"use client";

import { Cover } from "@/components/cover";
import { GONE_ROW_CLASS, GoneBadge } from "@/components/gone-mark";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDayAxis, fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { fmtMoney, type VideoMoney } from "@/lib/payment";
import type { PaymentStat } from "@/lib/types";
import { cn } from "@/lib/utils";

// Видео креатора с деньгами по каждому. Колонок с деньгами три — по одной на каждую ставку
// (владелец: «будет по каждой колонке, за что конкретно мы платим»), и общая сумма справа.
//
// 🔴 Зелёным горит цена того видео, которое можно оплачивать: окно закрылось, сумма
// окончательная, порог по числу видео набран. Всё остальное — серое: и то, что ещё набирает
// просмотры, и то, что уже оплачено, и то, у чего не было снимка внутри окна.

export type VideoMoneyRow = { stat: PaymentStat; money: VideoMoney };

export function VideosMoneyTable({ rows, gateOpen }: { rows: VideoMoneyRow[]; gateOpen: boolean }) {
  const t = useT();
  return (
    <Panel>
      <PanelHead title={t("payments.videosTitle")} subtitle={t("payments.historyFor", { n: rows.length, videos: t.plural("videos", rows.length) })} />
      {rows.length === 0 ? (
        <Empty>{t("payments.noVideos")}</Empty>
      ) : (
        <Table className="border-t">
          <TableHeader>
            <TableRow>
              <TableHead>{t("payments.colVideo")}</TableHead>
              <TableHead>{t("payments.colPublished")}</TableHead>
              <TableHead className="text-right">{t("payments.colViewsWindow")}</TableHead>
              <TableHead className="text-right">{t("payments.colViewsNow")}</TableHead>
              <TableHead className="text-right">{t("payments.colBase")}</TableHead>
              <TableHead className="text-right">{t("payments.colBonus")}</TableHead>
              <TableHead className="text-right">{t("payments.colExtra")}</TableHead>
              <TableHead className="text-right">{t("payments.colTotal")}</TableHead>
              <TableHead>{t("payments.colStatus")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ stat, money }) => {
              const payable = money.state === "final" && gateOpen;
              const dim = money.state === "nodata" || money.state === "paid";
              return (
                <TableRow key={stat.video_id} className={cn(stat.gone_at && GONE_ROW_CLASS)}>
                  <TableCell className="max-w-[22rem]">
                    <a
                      href={stat.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 hover:underline"
                    >
                      <Cover src={stat.cover_url} width={28} />
                      <span className="truncate">{stat.caption || "—"}</span>
                      <GoneBadge at={stat.gone_at} kind="video" />
                    </a>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDayAxis(stat.published_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money.state === "nodata" || stat.views_window === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      fmtNum(stat.views_window)
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNum(stat.views_now ?? 0)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", dim && "text-muted-foreground")}>
                    {fmtMoney(money.base)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", dim && "text-muted-foreground")}>
                    {fmtMoney(money.bonus)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", dim && "text-muted-foreground")}>
                    {money.extra > 0 ? fmtMoney(money.extra) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-medium tabular-nums",
                      payable && "text-[var(--up)]",
                      dim && "text-muted-foreground",
                    )}
                  >
                    {fmtMoney(money.total)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    <Status stat={stat} money={money} gateOpen={gateOpen} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function Status({ stat, money, gateOpen }: VideoMoneyRow & { gateOpen: boolean }) {
  const t = useT();
  if (money.state === "nodata") {
    return <span title={t("payments.stateNoDataHint")}>{t("payments.stateNoData")}</span>;
  }
  if (money.state === "paid") return <span>{t("payments.statePaid")}</span>;
  if (money.state === "pending") {
    return <span title={t("payments.windowCloses", { date: fmtDayAxis(stat.mark_at) })}>{t("payments.statePending")}</span>;
  }
  // Созревшее видео при незакрытом пороге: сумма уже окончательная, но платить ещё рано.
  if (!gateOpen) return <span>{t("payments.stateHeld")}</span>;
  return (
    <span
      className="text-[var(--up)]"
      title={stat.window_at ? t("payments.countedAt", { date: fmtDayAxis(stat.window_at) }) : undefined}
    >
      {t("payments.stateFinal")}
    </span>
  );
}

"use client";

import { useState } from "react";
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
  // Час берётся один раз при монтировании: спрашивать время в теле рендера нельзя — разметка
  // на сервере и в браузере разойдётся. Тот же приём, что у «Всего времени» на карточке.
  const [now] = useState(() => Date.now());
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
              {/* За какой промежуток вышел итог (владелец, 2026-09-19): у одних видео окно
                  закрылось ровно на 72 часах, у других обход пришёл позже — и это видно. */}
              <TableHead className="text-right">{t("payments.colHours")}</TableHead>
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
              // Серым — всё, за что сейчас не платят: уже оплаченное, удалённое и то,
              // у чего не было снимка внутри окна.
              const dim = money.state !== "final" && money.state !== "pending";
              // Платить не за что вовсе — вместо нулей прочерки: ноль читался бы как
              // «посчитали и вышло ноль», а тут считать не из чего.
              const nothing = money.state === "nodata";
              return (
                <TableRow key={stat.video_id} className={cn(stat.gone_at && GONE_ROW_CLASS)}>
                  {/* Подпись видео втрое уже прежнего (владелец, 2026-09-19: «тайтл слишком
                      длинный»); целиком она остаётся в подсказке. */}
                  <TableCell className="max-w-[8rem]">
                    <a
                      href={stat.url}
                      target="_blank"
                      rel="noreferrer"
                      title={stat.caption}
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
                  <TableCell className="text-right tabular-nums">
                    <Hours stat={stat} money={money} now={now} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNum(stat.views_now ?? 0)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", dim && "text-muted-foreground")}>
                    {nothing ? "—" : fmtMoney(money.base)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", dim && "text-muted-foreground")}>
                    {nothing ? "—" : fmtMoney(money.bonus)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", dim && "text-muted-foreground")}>
                    {!nothing && money.extra > 0 ? fmtMoney(money.extra) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-medium tabular-nums",
                      payable && "text-[var(--up)]",
                      dim && "text-muted-foreground",
                    )}
                  >
                    {nothing ? "—" : fmtMoney(money.total)}
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

// Сколько часов жизни видео стоит за числом в строке.
//
// 🔴 У созревшего это промежуток от публикации до снимка, по которому посчитаны деньги: обход
// ходит два раза в сутки, поэтому окно закрывается то ровно на 72 часах, то на 78 — и разница
// должна быть видна, а не спрятана (владелец, 2026-09-19).
// У незакрытого — возраст видео по часам: он идёт сам, без обновлений, и по нему видно, когда
// пора нажать «Обновить», чтобы окно закрылось близко к своим 72.
function Hours({ stat, money, now }: VideoMoneyRow & { now: number }) {
  const t = useT();
  if (money.state === "nodata") return <span className="text-muted-foreground">—</span>;
  const from = new Date(stat.published_at).getTime();
  const settled = stat.window_at !== null;
  const hours = Math.round(((settled ? new Date(stat.window_at as string).getTime() : now) - from) / 3_600_000);
  return (
    <span
      className={settled ? undefined : "text-muted-foreground"}
      title={
        settled
          ? t("payments.countedAt", { date: fmtDayAxis(stat.window_at as string) })
          : t("payments.hoursLeft", {
              n: stat.window_hours,
              date: fmtDayAxis(stat.mark_at),
              snap: stat.now_at ? fmtDayAxis(stat.now_at) : "—",
            })
      }
    >
      {t("payments.hours", { n: hours })}
    </span>
  );
}

function Status({ stat, money, gateOpen }: VideoMoneyRow & { gateOpen: boolean }) {
  const t = useT();
  if (money.state === "nodata") {
    return <span title={t("payments.stateNoDataHint")}>{t("payments.stateNoData")}</span>;
  }
  // Удалённое с площадки не оплачивается (владелец, 2026-09-19): сумма в строке видна, в
  // общий счёт не идёт.
  if (money.state === "gone") {
    return <span title={t("payments.stateGoneHint")}>{t("payments.stateGone")}</span>;
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

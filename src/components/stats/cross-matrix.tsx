"use client";

import { Avatar } from "@/components/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel, PanelHead, Empty } from "./panel";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { CrossMatrix as Matrix } from "@/lib/cross";
import { cn } from "@/lib/utils";

// «Кто кого комментировал»: строка — автор комментария, столбец — владелец видео.
//
// 🔴 Диагональ — это самокомментарии, и цвет у неё свой: свой комментарий под своим роликом
// обычное дело, а комментарий под чужим — событие, ради которого страница и заведена.
// Одним цветом они читались бы как одно и то же.
//
// Пустая матрица не прячется и не подменяется скелетом: честная строка «перекрёстных
// комментариев пока нет» говорит, что мы посмотрели и не нашли, а пустое место — что
// страница сломалась.
export function CrossMatrixPanel({
  matrix,
  collapseKey,
}: {
  matrix: Matrix;
  collapseKey?: string;
}) {
  const t = useT();
  const { creators, cells } = matrix;

  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead
        title={t("cross.matrixTitle")}
        subtitle={t("cross.matrixSubtitle", {
          cross: fmtNum(matrix.crossTotal),
          self: fmtNum(matrix.selfTotal),
        })}
      />
      {creators.length === 0 ? (
        <Empty>{t("cross.matrixEmpty")}</Empty>
      ) : (
        <>
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-muted-foreground">{t("cross.matrixAuthor")}</TableHead>
                {creators.map((c) => (
                  <TableHead key={c.id} className="text-right text-muted-foreground">
                    @{c.handle}
                  </TableHead>
                ))}
                <TableHead className="text-right text-muted-foreground">
                  {t("cross.matrixGiven")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {creators.map((from, i) => {
                const name = from.display_name || from.handle;
                const given = cells[i].reduce((s, n, j) => (i === j ? s : s + n), 0);
                return (
                  <TableRow key={from.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Avatar src={from.avatar_url} name={name} size={24} />
                        <span className="max-w-[10rem] truncate">@{from.handle}</span>
                      </span>
                    </TableCell>
                    {creators.map((to, j) => {
                      const n = cells[i][j];
                      const self = i === j;
                      return (
                        <TableCell
                          key={to.id}
                          className={cn(
                            "text-right tabular-nums",
                            n === 0 && "text-muted-foreground/40",
                            n > 0 && self && "bg-muted font-medium",
                            n > 0 && !self && "bg-amber-500/10 font-medium text-amber-700 dark:text-amber-400",
                          )}
                          title={
                            self
                              ? t("cross.matrixSelfCell", { handle: `@${from.handle}`, n: fmtNum(n) })
                              : t("cross.matrixCell", {
                                  from: `@${from.handle}`,
                                  to: `@${to.handle}`,
                                  n: fmtNum(n),
                                })
                          }
                        >
                          {n === 0 ? "—" : fmtNum(n)}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right font-medium tabular-nums">
                      {fmtNum(given)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {t("cross.matrixLegend")}
          </p>
        </>
      )}
    </Panel>
  );
}

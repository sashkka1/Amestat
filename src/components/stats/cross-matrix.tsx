"use client";

import { InfoIcon } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel, PanelHead, Empty } from "./panel";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { CrossMatrix as Matrix, CrossTotals } from "@/lib/cross";
import { cn } from "@/lib/utils";

// «Кто кого комментировал»: строка — автор комментария, столбец — владелец видео.
//
// 🔴 Диагональ — это самокомментарии, и цвет у неё свой: свой комментарий под своим роликом
// обычное дело, а комментарий под чужим — событие, ради которого всё это заведено.
// Одним цветом они читались бы как одно и то же.
//
// Пустая матрица не прячется и не подменяется скелетом: честная строка «перекрёстных
// комментариев пока нет» говорит, что мы посмотрели и не нашли, а пустое место — что
// страница сломалась.
//
// ⚠️ Панель стоит на дашборде свёрнутой (владелец, 2026-09-12): в шапке видно название и
// «столько-то перекрёстных», а таблица, итог за срок и честная строка про сравнимое —
// по щелчку. Они живут внутри этой же панели, а не отдельными блоками страницы: разговор
// один, и три карточки подряд про одно и то же дашборд бы только растянули.
export function CrossMatrixPanel({
  matrix,
  totals,
  collapseKey,
  defaultCollapsed = false,
}: {
  matrix: Matrix;
  // Итог перекрёстности за срок; не задан — строки с итогом нет.
  totals?: CrossTotals;
  collapseKey?: string;
  defaultCollapsed?: boolean;
}) {
  const t = useT();
  const { creators, cells } = matrix;

  return (
    <Panel collapseKey={collapseKey} defaultCollapsed={defaultCollapsed}>
      <PanelHead
        title={t("cross.matrixTitle")}
        subtitle={t("cross.matrixSubtitle", {
          cross: fmtNum(matrix.crossTotal),
          self: fmtNum(matrix.selfTotal),
        })}
      />
      {totals && <CrossSummary totals={totals} />}
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
      <HonestNote />
    </Panel>
  );
}

// Итог перекрёстности за срок словами: сколько комментариев от чужих наших, сколько своих
// под собой и у скольких видео это случилось. Ноль не прячется — он тоже ответ.
function CrossSummary({ totals }: { totals: CrossTotals }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t px-4 py-3 text-xs">
      <Stat label={t("cross.statCross")} value={fmtNum(totals.cross)} accent />
      <Stat label={t("cross.statCrossVideos")} value={fmtNum(totals.crossVideos)} accent />
      <Stat label={t("cross.statSelf")} value={fmtNum(totals.self)} />
      <Stat label={t("cross.statMentions")} value={fmtNum(totals.mentionVideos)} />
      {/* Знаменатель — снятые тексты, а не счётчик площадки: доля честна только к тому,
          что мы правда прочитали. */}
      <Stat label={t("cross.statTaken")} value={fmtNum(totals.total)} />
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          accent && "text-amber-600 dark:text-amber-500",
        )}
      >
        {value}
      </span>
    </span>
  );
}

// 🔴 Честная строка (владелец, 2026-09-11): что мы правда сравниваем и чего площадки не дают.
// Без неё жёлтые метки читались бы как «проверено всё», а проверены только комментарии,
// ответы и упоминания: лайки, просмотры, подписки и сохранения приходят числами без имён,
// и сопоставить их не с чем ни сейчас, ни потом.
function HonestNote() {
  const t = useT();
  return (
    <div className="flex items-start gap-2.5 border-t px-4 py-3 text-xs">
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-1">
        <p>
          <span className="font-medium">{t("cross.noteYes")}</span> {t("cross.noteYesText")}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">{t("cross.noteNo")}</span> {t("cross.noteNoText")}
        </p>
      </div>
    </div>
  );
}

"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Плитки с деньгами. Своя карточка, а не `KpiRow` дашборда: у тех числа сжимаются
// («16,8K») и под ними живут спарклайны с дельтой к прошлому сроку, а у денег ни того, ни
// другого быть не должно — доллары показываются полностью и до цента.
export type MoneyTile = {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  hint?: string;
  // Долг подсвечивается: это единственное число, ради которого на страницу и заходят.
  tone?: "due" | "plain";
  // Плитка долга нажимается — по ней открывается окно выплаты (владелец: «когда нажимаю на
  // финальную сумму, появляется окно, где я могу загрузить документ и указать сумму»).
  onClick?: () => void;
};

export function MoneyTiles({ items, className }: { items: MoneyTile[]; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border bg-card shadow-sm sm:grid-cols-3",
        items.length > 4 ? "xl:grid-cols-6 xl:divide-y-0" : "xl:grid-cols-4 xl:divide-y-0",
        className,
      )}
    >
      {items.map((tile) => {
        const Icon = tile.icon;
        const body = (
          <>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="size-3.5" />
              <span>{tile.label}</span>
            </div>
            <p
              className={cn(
                "text-2xl font-semibold tabular-nums tracking-tight",
                tile.tone === "due" && "text-[var(--up)]",
              )}
            >
              {tile.value}
            </p>
            {tile.hint && <p className="mt-auto text-xs text-muted-foreground">{tile.hint}</p>}
          </>
        );
        if (tile.onClick) {
          return (
            <button
              key={tile.key}
              type="button"
              onClick={tile.onClick}
              className="flex flex-col gap-1 p-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {body}
            </button>
          );
        }
        return (
          <div key={tile.key} className="flex flex-col gap-1 p-4">
            {body}
          </div>
        );
      })}
    </div>
  );
}

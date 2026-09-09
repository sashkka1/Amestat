"use client";

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";

// Заголовок-кнопка: первый клик — по убыванию, повторный меняет направление.
export function SortHead<K extends string>({
  k,
  label,
  sortKey,
  dir,
  onSort,
  align = "right",
  className,
}: {
  k: K;
  // Не только строка: у столбца «За период» под названием стоит вторая строка с датами.
  label: React.ReactNode;
  sortKey: K;
  dir: SortDir;
  onSort: (k: K) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = k === sortKey;
  return (
    <TableHead className={cn(align === "right" && "text-right", className)}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 text-left hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {active && (dir === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
      </button>
    </TableHead>
  );
}

// Общий переключатель направления для любой таблицы.
export function nextSort<K extends string>(
  current: K,
  dir: SortDir,
  clicked: K,
): { key: K; dir: SortDir } {
  if (clicked === current) return { key: current, dir: dir === "asc" ? "desc" : "asc" };
  return { key: clicked, dir: "desc" };
}

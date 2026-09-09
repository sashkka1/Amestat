"use client";

import { ArrowDownRightIcon, ArrowUpRightIcon } from "lucide-react";
import { changePct } from "@/lib/format";
import { cn } from "@/lib/utils";

// Значение против прошлого срока: стрелка и проценты, цвет — как у плиток сводки.
// Сравнивать не с чем (в прошлом сроке ноль) — «—» серым, без стрелки.
//
// Один и тот же вид нужен и «Лучшим креаторам» на дашборде, и столбцу «за 7 дней» в списке
// креаторов, поэтому он лежит здесь.
export function Delta({
  now,
  prev,
  className,
  title,
}: {
  now: number;
  prev: number;
  className?: string;
  title?: string;
}) {
  const change = changePct(now, prev);
  const Arrow =
    change.tone === "up" ? ArrowUpRightIcon : change.tone === "down" ? ArrowDownRightIcon : null;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center justify-end gap-0.5 tabular-nums",
        change.tone === "up" && "text-[var(--up)]",
        change.tone === "down" && "text-[var(--down)]",
        change.tone === "flat" && "text-muted-foreground",
        className,
      )}
    >
      {Arrow && <Arrow className="size-3 shrink-0" />}
      {change.text}
    </span>
  );
}

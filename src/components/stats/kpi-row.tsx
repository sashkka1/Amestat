"use client";

import {
  EyeIcon,
  FlameIcon,
  HeartIcon,
  MessageCircleIcon,
  Share2Icon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import { changeVs, fmtCompact, fmtNum } from "@/lib/format";
import type { Totals } from "@/lib/queries";
import { cn } from "@/lib/utils";

export type Kpi = { key: string; label: string; icon: LucideIcon; value: number; prev: number };

// Шесть плиток одной карточкой, разделённые вертикальными линиями.
export function KpiRow({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border bg-card shadow-sm sm:grid-cols-3 xl:grid-cols-6 xl:divide-y-0">
      {items.map((k) => (
        <Tile key={k.key} kpi={k} />
      ))}
    </div>
  );
}

function Tile({ kpi }: { kpi: Kpi }) {
  const Icon = kpi.icon;
  const change = changeVs(kpi.value, kpi.prev);
  return (
    <div className="flex flex-col gap-1 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        <span>{kpi.label}</span>
      </div>
      <p
        className="text-2xl font-semibold tabular-nums tracking-tight"
        title={fmtNum(kpi.value)}
      >
        {fmtCompact(kpi.value)}
      </p>
      <p
        className={cn(
          "text-xs tabular-nums",
          change.tone === "up" && "text-[var(--up)]",
          change.tone === "down" && "text-[var(--down)]",
          change.tone === "flat" && "text-muted-foreground",
        )}
      >
        {change.text}
      </p>
    </div>
  );
}

// Шесть счётчиков сводки в том порядке, в каком они стоят на макете.
export function totalsToKpis(now: Totals, prev: Totals): Kpi[] {
  return [
    { key: "views", label: "Просмотры", icon: EyeIcon, value: now.views, prev: prev.views },
    { key: "eng", label: "Вовлечённость", icon: FlameIcon, value: now.engagement, prev: prev.engagement },
    { key: "likes", label: "Лайки", icon: HeartIcon, value: now.likes, prev: prev.likes },
    { key: "comments", label: "Комментарии", icon: MessageCircleIcon, value: now.comments, prev: prev.comments },
    { key: "shares", label: "Репосты", icon: Share2Icon, value: now.shares, prev: prev.shares },
    { key: "videos", label: "Видео", icon: VideoIcon, value: now.videos, prev: prev.videos },
  ];
}

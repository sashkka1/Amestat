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
import { Panel, PanelHead } from "./panel";
import { changeVs, fmtCompact, fmtNum } from "@/lib/format";
import { tr, useT } from "@/lib/i18n";
import type { Totals } from "@/lib/queries";
import { cn } from "@/lib/utils";

export type Kpi = { key: string; label: string; icon: LucideIcon; value: number; prev: number };

// Шесть плиток одной карточкой, разделённые вертикальными линиями.
//
// `collapseKey` — плитки сворачиваются, как остальные блоки дашборда. Тогда у них появляется
// шапка с названием (сами по себе плитки заголовка не имеют), а рамку и фон даёт `Panel`.
export function KpiRow({ items, collapseKey }: { items: Kpi[]; collapseKey?: string }) {
  const t = useT();
  const grid = (
    <div
      className={cn(
        "grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-3 xl:grid-cols-6 xl:divide-y-0",
        collapseKey === undefined
          ? "overflow-hidden rounded-xl border bg-card shadow-sm"
          : "border-t",
      )}
    >
      {items.map((k) => (
        <Tile key={k.key} kpi={k} />
      ))}
    </div>
  );
  if (collapseKey === undefined) return grid;
  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead title={t("dashboard.kpiTitle")} />
      {grid}
    </Panel>
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
    { key: "views", label: tr("metric.views"), icon: EyeIcon, value: now.views, prev: prev.views },
    { key: "eng", label: tr("metric.engagement"), icon: FlameIcon, value: now.engagement, prev: prev.engagement },
    { key: "likes", label: tr("metric.likes"), icon: HeartIcon, value: now.likes, prev: prev.likes },
    { key: "comments", label: tr("metric.comments"), icon: MessageCircleIcon, value: now.comments, prev: prev.comments },
    { key: "shares", label: tr("metric.shares"), icon: Share2Icon, value: now.shares, prev: prev.shares },
    { key: "videos", label: tr("metric.videos"), icon: VideoIcon, value: now.videos, prev: prev.videos },
  ];
}

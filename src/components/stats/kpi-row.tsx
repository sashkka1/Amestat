"use client";

import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  EyeIcon,
  FlameIcon,
  HeartIcon,
  MessageCircleIcon,
  Share2Icon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import { Panel, PanelHead } from "./panel";
import { Sparkline } from "./sparkline";
import { changeVs, fmtCompact, fmtNum } from "@/lib/format";
import { tr, useT } from "@/lib/i18n";
import type { Totals } from "@/lib/queries";
import type { DailyViews } from "@/lib/types";
import { cn } from "@/lib/utils";

// `series` — дневной ряд за тот же срок, из которого сложилось `value`; его нет у счётчиков,
// которых база по дням не отдаёт (вовлечённость, число видео), и тогда спарклайн не рисуется.
// `color` — цвет ряда на «Динамике»: один счётчик — один цвет во всём дашборде.
// `prev` — то же за прошлый срок; null значит «не сравниваем» (переключатель полосы периода),
// и тогда строки с дельтой у плитки нет вовсе. Ноль на её месте соврал бы про «−100%».
export type Kpi = {
  key: string;
  label: string;
  icon: LucideIcon;
  value: number;
  prev: number | null;
  series?: number[];
  color?: string;
};

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
  const change = kpi.prev === null ? null : changeVs(kpi.value, kpi.prev);
  const Arrow =
    change === null ? null : change.tone === "up" ? ArrowUpRightIcon : change.tone === "down" ? ArrowDownRightIcon : null;
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
      {change && (
        <p
          className={cn(
            "flex items-center gap-0.5 text-xs tabular-nums",
            change.tone === "up" && "text-[var(--up)]",
            change.tone === "down" && "text-[var(--down)]",
            change.tone === "flat" && "text-muted-foreground",
          )}
        >
          {Arrow && <Arrow className="size-3 shrink-0" />}
          {change.text}
        </p>
      )}
      {/* mt-auto — линия прижата к низу плитки: у соседей без ряда её нет, и без этого
          спарклайны стояли бы на разной высоте. */}
      <Sparkline values={kpi.series} color={kpi.color} className="mt-auto" />
    </div>
  );
}

// Шесть счётчиков сводки в том порядке, в каком они стоят на макете.
//
// `daily` необязателен: у кого дневного ряда нет, у того плитка остаётся без спарклайна.
// Своего ряда по дням нет ни у вовлечённости, ни у числа видео — база их по дням не отдаёт,
// и складывать их из чужих рядов значило бы рисовать выдуманное.
//
// `prev` — null, когда сравнение выключено полосой периода: тогда прошлый срок вообще
// не читался, и дельту брать неоткуда.
export function totalsToKpis(now: Totals, prev: Totals | null, daily?: DailyViews[]): Kpi[] {
  // Ряд базы — счётчики видео по дню их публикации (миграция v21): спарклайн рисует его как
  // есть, ничего не вычитая. Сумма ряда за срок равна значению самой плитки — это одни и те
  // же видео, посчитанные по дням и целиком.
  const series = (key: "views" | "likes" | "comments" | "shares") =>
    daily && daily.length > 1 ? daily.map((d) => d[key]) : undefined;
  const was = (key: keyof Totals) => (prev ? prev[key] : null);
  return [
    { key: "views", label: tr("metric.views"), icon: EyeIcon, value: now.views, prev: was("views"), series: series("views"), color: "var(--chart-1)" },
    { key: "eng", label: tr("metric.engagement"), icon: FlameIcon, value: now.engagement, prev: was("engagement") },
    { key: "likes", label: tr("metric.likes"), icon: HeartIcon, value: now.likes, prev: was("likes"), series: series("likes"), color: "var(--chart-3)" },
    { key: "comments", label: tr("metric.comments"), icon: MessageCircleIcon, value: now.comments, prev: was("comments"), series: series("comments"), color: "var(--chart-4)" },
    { key: "shares", label: tr("metric.shares"), icon: Share2Icon, value: now.shares, prev: was("shares"), series: series("shares"), color: "var(--chart-5)" },
    // Плитка называется «Посты» (владелец, 2026-09-09): считаются вышедшие за срок
    // публикации, а «видео» — это уже строки таблицы ниже. Ключ `metric.videos` остался за
    // ними, у плитки свой.
    { key: "videos", label: tr("metric.posts"), icon: VideoIcon, value: now.videos, prev: was("videos") },
  ];
}

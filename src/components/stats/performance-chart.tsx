"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel, PanelHead, Empty } from "./panel";
import { fmtCompact, fmtDayAxis, fmtNum } from "@/lib/format";
import type { DailyViews } from "@/lib/types";
import { cn } from "@/lib/utils";

type Mode = "daily" | "total";

const SERIES = [
  { key: "views", label: "Просмотры", color: "var(--chart-1)" },
  { key: "likes", label: "Лайки", color: "var(--chart-3)" },
] as const;
type SeriesKey = (typeof SERIES)[number]["key"];

// «Динамика»: ряды по дням. База отдаёт накопительные счётчики на конец каждого дня,
// поэтому «по дням» — это разность с предыдущим днём, «накопительно» — сами суммы.
// Рядов два, а не пять: daily_views_all и creator_daily_views считают только просмотры
// и лайки; комментарии и репосты по дням в базе не разложены.
export function PerformanceChart({
  data,
  right,
  title = "Динамика",
}: {
  data: DailyViews[];
  right?: React.ReactNode;
  title?: string;
}) {
  const [mode, setMode] = useState<Mode>("daily");
  const [hidden, setHidden] = useState<Set<SeriesKey>>(() => new Set());

  const rows = useMemo(() => {
    if (mode === "total") return data.map((d) => ({ day: d.day, views: d.views, likes: d.likes }));
    return data.map((d, i) => {
      const prev = i === 0 ? null : data[i - 1];
      return {
        day: d.day,
        views: prev ? Math.max(d.views - prev.views, 0) : 0,
        likes: prev ? Math.max(d.likes - prev.likes, 0) : 0,
      };
    });
  }, [data, mode]);

  function toggle(k: SeriesKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else if (next.size < SERIES.length - 1) next.add(k);
      return next;
    });
  }

  return (
    <Panel>
      <PanelHead title={title}>
        {right}
        <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
          <ModeButton active={mode === "daily"} onClick={() => setMode("daily")}>
            По дням
          </ModeButton>
          <ModeButton active={mode === "total"} onClick={() => setMode("total")}>
            Накопительно
          </ModeButton>
        </div>
      </PanelHead>

      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {SERIES.map((s) => {
          const on = !hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity",
                on ? "bg-muted/60" : "opacity-45",
              )}
            >
              <span className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <Empty>За этот срок данных нет.</Empty>
      ) : (
        <div className="h-64 w-full px-2 pb-3 sm:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                {SERIES.map((s) => (
                  <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={fmtDayAxis}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(v: number) => fmtCompact(v)}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip
                formatter={(v, name) => [fmtNum(Number(v)), String(name)]}
                labelFormatter={(l) => fmtDayAxis(String(l))}
                contentStyle={{
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--popover)",
                  color: "var(--popover-foreground)",
                  fontSize: 12,
                }}
              />
              {SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stackId="1"
                  stroke={s.color}
                  strokeWidth={1.5}
                  fill={`url(#fill-${s.key})`}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

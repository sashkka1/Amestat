"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtCompact, fmtDayAxis, fmtNum } from "@/lib/format";

// История одного видео: просмотры по снимкам. Ряды по дням рисует PerformanceChart.
export function VideoHistoryChart({ data }: { data: { t: string; views: number }[] }) {
  if (data.length < 2) {
    return <p className="py-6 text-center text-xs text-muted-foreground">Снимков пока мало для графика.</p>;
  }
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={fmtDayAxis}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => fmtCompact(v)}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            formatter={(v) => [fmtNum(Number(v)), "Просмотры"]}
            labelFormatter={(l) => new Date(String(l)).toLocaleString("ru-RU")}
            contentStyle={{
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--popover)",
              color: "var(--popover-foreground)",
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="views"
            stroke="var(--chart-1)"
            strokeWidth={1.5}
            fill="var(--chart-1)"
            fillOpacity={0.12}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

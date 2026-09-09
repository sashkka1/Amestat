"use client";

import { useId, useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

// Ход счётчика по дням: ни осей, ни сетки, ни подписей — только форма. Один и тот же
// рисунок стоит в плитках сводки (`kpi-row.tsx`) и в ячейке «за 7 дней» списка креаторов,
// поэтому он живёт здесь, а не внутри плитки.
//
// ⚠️ Меньше двух точек — линии нет вовсе: одна точка формы не рисует, а прямая по ней
// соврала бы про «ровно».
export function Sparkline({
  values,
  color = "var(--chart-1)",
  className,
}: {
  values: number[] | undefined;
  color?: string;
  className?: string;
}) {
  // Идентификатор градиента обязан быть свой у каждого рисунка: одинаковый id на странице
  // склеил бы заливки. useId отдаёт строку со знаками, недопустимыми внутри url(#…) —
  // поэтому оставляем от неё только буквы и цифры.
  const raw = useId();
  const id = useMemo(() => `spark-${raw.replace(/[^a-zA-Z0-9]/g, "")}`, [raw]);
  const rows = useMemo(() => (values ?? []).map((v, i) => ({ i, v })), [values]);
  if (rows.length < 2) return null;
  return (
    <div className={cn("h-7 w-full", className)} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${id})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

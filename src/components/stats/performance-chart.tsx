"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel, PanelHead, Empty } from "./panel";
import { fmtCompact, fmtDayAxis, fmtNum } from "@/lib/format";
import { useT, type TKey } from "@/lib/i18n";
import { toDateInputValue, type PeriodRange } from "@/lib/period";
import { creatorDailyViews } from "@/lib/queries";
import { useScope } from "@/lib/dashboard-prefs";
import { runningTotal } from "@/lib/stats";
import type { DailyViews } from "@/lib/types";
import { cn } from "@/lib/utils";

type Mode = "daily" | "total";
// Шаг оси: день или неделя. Недели предлагаются только на длинном сроке — см. WEEK_AFTER.
type Bucket = "day" | "week";
// Что рисуем: пять счётчиков сводки или просмотры пяти лучших креаторов.
type Source = "series" | "creators";

const SERIES = [
  { key: "views", label: "metric.views", color: "var(--chart-1)" },
  { key: "likes", label: "metric.likes", color: "var(--chart-3)" },
  { key: "comments", label: "metric.comments", color: "var(--chart-4)" },
  { key: "shares", label: "metric.shares", color: "var(--chart-5)" },
  { key: "saves", label: "metric.saves", color: "var(--chart-2)" },
] as const satisfies readonly { key: string; label: TKey; color: string }[];

// Дольше этого срока подписи по дням сливаются в кашу, и появляется переключатель «Недели».
const WEEK_AFTER = 35;
// Сколько креаторов рисует режим «По креаторам»: больше пяти линий уже не читаются.
const TOP_CREATORS = 5;
// Цвета линий креаторов — те же пять, что у счётчиков: своей палитры у площадок нет.
const CREATOR_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-2)",
];

export type ChartCreator = { id: string; name: string };

type Row = Record<string, number | string> & { day: string };
type Column = { key: string; values: number[] };

// Ряд базы → то, что рисуем. База отдаёт день как «сколько набрали видео, вышедшие в этот
// день» (миграция v21), поэтому «по дням» — это её значения как есть, а «накопительно» —
// бегущая сумма от начала срока.
function toMode(values: number[], mode: Mode): number[] {
  return mode === "total" ? runningTotal(values) : values;
}

// Понедельник той недели, в которую попал день: по нему дни собираются в недельные столбцы,
// он же становится подписью недели на оси.
function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateInputValue(d);
}

// Колонки значений → строки recharts. Неделя суммирует свои дни, но только в режиме «по дням»:
// в «накопительно» значения уже сложены бегущей суммой, и складывать их снова значило бы
// посчитать одно и то же семь раз — там неделя берёт значение своего последнего дня.
function buildRows(days: string[], cols: Column[], bucket: Bucket, mode: Mode): Row[] {
  if (bucket === "day") {
    return days.map((day, i) => {
      const row: Row = { day };
      for (const c of cols) row[c.key] = c.values[i] ?? 0;
      return row;
    });
  }
  const rows: Row[] = [];
  let current = "";
  for (let i = 0; i < days.length; i++) {
    const wk = weekStart(days[i]);
    if (wk !== current) {
      current = wk;
      const fresh: Row = { day: wk };
      for (const c of cols) fresh[c.key] = 0;
      rows.push(fresh);
    }
    const row = rows[rows.length - 1];
    for (const c of cols) {
      const v = c.values[i] ?? 0;
      row[c.key] = mode === "total" ? v : Number(row[c.key]) + v;
    }
  }
  return rows;
}

// Ряды пяти лучших креаторов: читаются лениво, только когда включили режим «По креаторам»,
// и держатся в состоянии по ключу «срок + пятёрка» — переключение туда-обратно базу не дёргает.
type CreatorSeries = { key: string; days: string[]; cols: Column[] };

// «Динамика»: пять рядов по дням (миграции v4 и v21). Метрики отнесены к ДАТЕ ПУБЛИКАЦИИ:
// столбец дня — текущие счётчики видео, вышедших в этот день (владелец, 2026-09-09: «все
// графики должны работать по дню публикации, вне зависимости от того, в какой день сборщик
// что-то словил»). «Накопительно» — бегущая сумма этих значений от начала срока.
//
// `range` и `creators` нужны только режиму «По креаторам»: без них третий сегмент не рисуется
// вовсе (так карточка креатора и живёт — там сравнивать не с кем).
export function PerformanceChart({
  data,
  right,
  title,
  collapseKey,
  range,
  creators,
}: {
  data: DailyViews[];
  right?: React.ReactNode;
  title?: string;
  collapseKey?: string;
  range?: PeriodRange | null;
  creators?: ChartCreator[];
}) {
  const t = useT();
  // Тот же стор охвата, что у полосы периода: график дочитывает ряды сам, значит и охват
  // берёт сам.
  const { scope } = useScope();
  const [mode, setMode] = useState<Mode>("daily");
  const [bucketPick, setBucketPick] = useState<Bucket>("day");
  const [source, setSource] = useState<Source>("series");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState<CreatorSeries | null>(null);
  const [creatorsError, setCreatorsError] = useState<string | null>(null);

  // Недели предлагаются только на длинном сроке; срок укоротили — ось возвращается к дням,
  // не дожидаясь, пока переключатель нажмут обратно (кнопок-то уже нет).
  const weekly = data.length > WEEK_AFTER;
  const bucket: Bucket = weekly ? bucketPick : "day";

  const top = useMemo(() => (creators ?? []).slice(0, TOP_CREATORS), [creators]);
  const byCreators = source === "creators" && top.length > 0;
  // Ключ кэша: тот же срок и та же пятёрка — то же самое, читать заново нечего.
  // Охват в ключе: ряды «По креаторам» читаются той же функцией с тем же p_only_ours, что и
  // основной ряд (миграция v22), иначе режим показывал бы другой набор видео, чем график.
  const cacheKey =
    range && top.length > 0
      ? `${range.from.getTime()}|${range.to.getTime()}|${scope}|${top.map((c) => c.id).join(",")}`
      : null;

  useEffect(() => {
    if (source !== "creators" || !range || !cacheKey) return;
    if (loaded?.key === cacheKey) return;
    let alive = true;
    // Ошибка гасится удачным ответом, а не началом запроса: setState прямо в теле эффекта
    // тянет лишний каскад перерисовок (правило react-hooks/set-state-in-effect).
    Promise.all(top.map((c) => creatorDailyViews(c.id, range, scope))).then(
      (series) => {
        if (!alive) return;
        setCreatorsError(null);
        // Сетку дней даёт generate_series внутри функции, поэтому она у всех креаторов одна;
        // берём её у первого непустого, а сводим всё равно по дню — на случай пустого ответа.
        const days = series.find((s) => s.length > 0)?.map((d) => d.day) ?? data.map((d) => d.day);
        const cols = top.map((c, i) => {
          const byDay = new Map(series[i].map((d) => [d.day, d.views]));
          return { key: c.id, values: days.map((day) => byDay.get(day) ?? 0) };
        });
        setLoaded({ key: cacheKey, days, cols });
      },
      (e: unknown) => {
        if (alive) setCreatorsError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      alive = false;
    };
    // `data` участвует только запасной сеткой дней и перечитывать ряды не обязано.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, cacheKey, range, top, loaded?.key]);

  // Что рисуем сейчас: пять счётчиков или пять креаторов. Одна и та же форма — ключ, подпись,
  // цвет, — поэтому легенда, подсказка и сам график про разницу не знают.
  const items = useMemo(
    () =>
      byCreators
        ? top.map((c, i) => ({ key: c.id, label: c.name, color: CREATOR_COLORS[i % CREATOR_COLORS.length] }))
        : SERIES.map((s) => ({ key: s.key as string, label: t(s.label), color: s.color })),
    [byCreators, top, t],
  );

  const fresh = byCreators && loaded?.key === cacheKey ? loaded : null;
  const rows = useMemo(() => {
    if (byCreators) {
      if (!fresh) return [];
      return buildRows(
        fresh.days,
        fresh.cols.map((c) => ({ key: c.key, values: toMode(c.values, mode) })),
        bucket,
        mode,
      );
    }
    const days = data.map((d) => d.day);
    const cols = SERIES.map((s) => ({ key: s.key as string, values: toMode(data.map((d) => d[s.key]), mode) }));
    return buildRows(days, cols, bucket, mode);
  }, [byCreators, fresh, data, mode, bucket]);

  const colorByKey = useMemo(
    () => Object.fromEntries(items.map((i) => [i.key, i.color])),
    [items],
  );
  const visible = items.filter((i) => !hidden.has(i.key));

  // Прячем по щелчку в легенду, но не последнюю: пустой график ничего не сообщает.
  function toggle(k: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else if (items.filter((i) => !next.has(i.key)).length > 1) next.add(k);
      return next;
    });
  }

  // Наборы ключей у счётчиков и у креаторов разные, и спрятанное одного набора во втором
  // означало бы случайно погасшую линию — при смене режима список скрытых сбрасывается.
  function pickSource(next: Source) {
    setSource(next);
    setHidden(new Set());
  }

  const empty = creatorsError
    ? t("chart.creatorsError", { error: creatorsError })
    : byCreators && !fresh
      ? t("chart.creatorsLoading")
      : t("chart.empty");

  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead title={title ?? t("chart.title")}>
        {right}
        {top.length > 0 && range && (
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
            <ModeButton active={source === "series"} onClick={() => pickSource("series")}>
              {t("chart.series")}
            </ModeButton>
            <ModeButton active={source === "creators"} onClick={() => pickSource("creators")}>
              {t("chart.byCreators")}
            </ModeButton>
          </div>
        )}
        {weekly && (
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
            <ModeButton active={bucket === "day"} onClick={() => setBucketPick("day")}>
              {t("chart.days")}
            </ModeButton>
            <ModeButton active={bucket === "week"} onClick={() => setBucketPick("week")}>
              {t("chart.weeks")}
            </ModeButton>
          </div>
        )}
        <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
          <ModeButton active={mode === "daily"} onClick={() => setMode("daily")}>
            {t("chart.byDay")}
          </ModeButton>
          <ModeButton active={mode === "total"} onClick={() => setMode("total")}>
            {t("chart.cumulative")}
          </ModeButton>
        </div>
      </PanelHead>

      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {items.map((it) => {
          const on = !hidden.has(it.key);
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => toggle(it.key)}
              aria-pressed={on}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity",
                on ? "bg-muted/60" : "opacity-45",
              )}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: it.color }} />
              <span className="truncate">{it.label}</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className="h-64 w-full px-2 sm:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
                cursor={{ stroke: "var(--border)" }}
                content={(props) => <DayTip {...props} colors={colorByKey} />}
              />
              {/* Счётчики складываются в стопку — вместе они и есть «вся динамика»; линии
                  креаторов сравниваются друг с другом, и складывать их нельзя. */}
              {byCreators
                ? visible.map((it) => (
                    <Line
                      key={it.key}
                      type="monotone"
                      dataKey={it.key}
                      name={it.label}
                      stroke={it.color}
                      strokeWidth={1.75}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))
                : visible.map((it) => (
                    <Area
                      key={it.key}
                      type="monotone"
                      dataKey={it.key}
                      name={it.label}
                      stackId="1"
                      stroke={it.color}
                      strokeWidth={1.5}
                      fill={`url(#fill-${it.key})`}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Подпись про атрибуцию: без неё столбец дня легко прочитать как «столько собрали
          в этот день», а он про другое — про ролики, вышедшие в этот день. */}
      <p className="px-4 pb-3 text-xs text-muted-foreground">{t("chart.note")}</p>
    </Panel>
  );
}

// Форма записи подсказки у recharts шире, чем нам нужно (dataKey бывает и функцией),
// поэтому берём её как есть и сужаем на месте.
type TipPayload = {
  dataKey?: string | number | ((obj: never) => unknown);
  name?: React.ReactNode;
  value?: unknown;
  color?: string;
};

// Подсказка перечисляет все видимые ряды за день: цветная точка, имя, полное число.
// Цвет берём из своей таблицы, а не из payload: у площадей там лежит url(#…) градиента,
// и точка вышла бы пустой.
function DayTip({
  active,
  payload,
  label,
  colors,
}: {
  active?: boolean;
  // Recharts отдаёт список только для чтения — тип обязан это повторить, иначе элемент
  // не подходит под `content`.
  payload?: readonly TipPayload[];
  label?: unknown;
  colors: Record<string, string>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-[10px] border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{fmtDayAxis(String(label ?? ""))}</p>
      <ul className="space-y-0.5">
        {payload.map((e, i) => (
          <li key={String(e.dataKey ?? i)} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: colors[String(e.dataKey)] ?? e.color }}
            />
            <span className="mr-4 max-w-40 truncate">{e.name}</span>
            <span className="ml-auto font-medium tabular-nums">{fmtNum(Number(e.value ?? 0))}</span>
          </li>
        ))}
      </ul>
    </div>
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

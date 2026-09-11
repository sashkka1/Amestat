"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { Panel, PanelHead, Empty } from "./panel";
import { fmtBucketAxis, fmtBucketFull, fmtCompact, fmtDayAxis, fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Bucket } from "@/lib/queries";
import type { DailyViews, Platform } from "@/lib/types";

// Ряд из трёх карточек под «Динамикой»: сколько выходило видео, как шли просмотры по
// площадкам и в какой доле они поделились. Своих запросов здесь нет — всё считается на
// клиенте из того, что страница уже прочитала.
//
// Цвета площадок: у проекта их нет (значки в `components/platform.tsx` серые), поэтому
// TikTok — `--chart-1`, Instagram — `--chart-2`, как договорено.
const COLOR: Record<Platform, string> = { tiktok: "var(--chart-1)", instagram: "var(--chart-2)" };
const LABEL: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram" };

const TIP_STYLE = {
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  fontSize: 12,
} as const;

const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" } as const;

// Подписи оси и подсказки: при часовом шаге — «14:00» и «11 September, 14:00–15:00»; при
// остальных — дата начала отрезка, как было до часов.
function axisLabel(iso: string, bucket: Bucket): string {
  return bucket === "hour" ? fmtBucketAxis(iso, "hour") : fmtDayAxis(iso);
}

function tipLabel(iso: string, bucket: Bucket): string {
  return bucket === "hour" ? fmtBucketFull(iso, "hour") : fmtDayAxis(iso);
}

// Просмотры по дню публикации видео: база отдаёт ряд как есть (миграция v21), здесь остаётся
// только разложить его по сетке отрезков страницы. Ключ — `at`, начало отрезка (миграция v27).
function viewsByDay(rows: DailyViews[]): Map<string, number> {
  return new Map(rows.map((d) => [d.at, d.views]));
}

// Публикации по отрезкам: у видео момент публикации, а столбец — отрезок сетки (час, день,
// неделя или месяц в поясе браузера — в нём же базу и просили резать ряд). Видео ложится в
// последний отрезок, начавшийся не позже его публикации; раньше первого — мимо сетки.
function countByBucket(slots: string[], publishedAt: string[]): number[] {
  const starts = slots.map((s) => new Date(s).getTime());
  const out = starts.map(() => 0);
  for (const iso of publishedAt) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t) || starts.length === 0 || t < starts[0]) continue;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    out[lo] += 1;
  }
  return out;
}

// Столбцы публикаций: сетка отрезков → сколько роликов вышло. Считается и здесь, и в
// одиночной карточке ниже — поэтому расчёт общий.
function usePostRows(days: string[], publishedAt: string[]) {
  const rows = useMemo(() => {
    const counted = countByBucket(days, publishedAt);
    return days.map((at, i) => ({ at, n: counted[i] }));
  }, [days, publishedAt]);
  const total = useMemo(() => rows.reduce((s, r) => s + r.n, 0), [rows]);
  return { rows, total };
}

// Сам рисунок карточки «Публикации по дням» — без обёртки: в ряду обзора он стоит внутри
// `Card`, а на карточке креатора — внутри отдельной панели.
function PostsChart({
  rows,
  total,
  bucket,
}: {
  rows: { at: string; n: number }[];
  total: number;
  bucket: Bucket;
}) {
  const t = useT();
  if (total === 0) return <Empty>{t("overview.empty")}</Empty>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <XAxis
          dataKey="at"
          tickFormatter={(v: string) => axisLabel(v, bucket)}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          formatter={(v) => [fmtNum(Number(v)), t("overview.postsLegend")]}
          labelFormatter={(l) => tipLabel(String(l), bucket)}
          contentStyle={TIP_STYLE}
        />
        <Bar dataKey="n" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// Та же карточка, но отдельной панелью — для страниц, где площадка одна и остальные две
// карточки обзора не имеют смысла (карточка креатора): тренд по площадкам там нечему
// сравнивать, а доля всегда 100%.
export function PostsPerDay({
  days,
  publishedAt,
  bucket,
  collapseKey,
}: {
  days: string[];
  publishedAt: string[];
  bucket: Bucket;
  collapseKey?: string;
}) {
  const t = useT();
  const { rows, total } = usePostRows(days, publishedAt);
  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead
        title={t("overview.posts")}
        subtitle={t("overview.postsTotal", { n: fmtNum(total) })}
      />
      <div className="h-50 border-t p-4">
        <PostsChart rows={rows} total={total} bucket={bucket} />
      </div>
    </Panel>
  );
}

export function OverviewCards({
  days,
  publishedAt,
  tiktok,
  instagram,
  bucket,
  collapseKey,
}: {
  // Сетка отрезков срока (`at`) — из того же ряда, что рисует «Динамику»: столбцы и линии
  // карточек стоят по тем же отрезкам, что и график над ними.
  days: string[];
  // Шаг этой сетки: по нему подписываются ось и подсказка.
  bucket: Bucket;
  // Даты публикации видео, попавших в срок (после фильтра площадки).
  publishedAt: string[];
  // Ряды по площадкам. Пустой — площадка отключена переключателем: тогда её нет ни в линиях,
  // ни в кольце, и доля второй становится 100%.
  tiktok: DailyViews[];
  instagram: DailyViews[];
  collapseKey?: string;
}) {
  const t = useT();

  const { rows: postRows, total: postsTotal } = usePostRows(days, publishedAt);

  const trendRows = useMemo(() => {
    const tk = viewsByDay(tiktok);
    const ig = viewsByDay(instagram);
    return days.map((at) => ({ at, tiktok: tk.get(at) ?? 0, instagram: ig.get(at) ?? 0 }));
  }, [days, tiktok, instagram]);

  // Доля площадки — сумма её дневных значений за срок: то же число, что нарисовано линией.
  const shares = useMemo(() => {
    const sum = (p: Platform) => trendRows.reduce((s, r) => s + r[p], 0);
    const rows = (["tiktok", "instagram"] as Platform[])
      .map((p) => ({ platform: p, value: sum(p) }))
      .filter((r) => r.value > 0);
    const total = rows.reduce((s, r) => s + r.value, 0);
    return { rows, total };
  }, [trendRows]);

  const trendTotal = shares.total;
  const hasPlatforms = tiktok.length > 0 || instagram.length > 0;

  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead title={t("overview.title")} />
      <div className="grid grid-cols-1 divide-y divide-border border-t lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <Card
          title={t("overview.posts")}
          total={t("overview.postsTotal", { n: fmtNum(postsTotal) })}
          legend={[{ key: "posts", label: t("overview.postsLegend"), color: "var(--chart-1)" }]}
        >
          <PostsChart rows={postRows} total={postsTotal} bucket={bucket} />
        </Card>

        <Card
          title={t("overview.trend")}
          total={t("overview.trendTotal", { n: fmtCompact(trendTotal) })}
          legend={(["tiktok", "instagram"] as Platform[])
            .filter((p) => (p === "tiktok" ? tiktok.length > 0 : instagram.length > 0))
            .map((p) => ({ key: p, label: LABEL[p], color: COLOR[p] }))}
        >
          {!hasPlatforms || trendRows.length === 0 ? (
            <Empty>{t("overview.empty")}</Empty>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendRows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  {(["tiktok", "instagram"] as Platform[]).map((p) => (
                    <linearGradient key={p} id={`ov-${p}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={COLOR[p]} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={COLOR[p]} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <XAxis
                  dataKey="at"
                  tickFormatter={(v: string) => axisLabel(v, bucket)}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <Tooltip
                  formatter={(v, name) => [fmtNum(Number(v)), String(name)]}
                  labelFormatter={(l) => tipLabel(String(l), bucket)}
                  contentStyle={TIP_STYLE}
                />
                {(["tiktok", "instagram"] as Platform[])
                  .filter((p) => (p === "tiktok" ? tiktok.length > 0 : instagram.length > 0))
                  .map((p) => (
                    <Area
                      key={p}
                      type="monotone"
                      dataKey={p}
                      name={LABEL[p]}
                      stroke={COLOR[p]}
                      strokeWidth={1.5}
                      fill={`url(#ov-${p})`}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title={t("overview.share")} subtitle={t("overview.shareSubtitle")}>
          {shares.rows.length === 0 ? (
            <Empty>{t("overview.empty")}</Empty>
          ) : (
            <div className="flex h-full items-center gap-3">
              <div className="h-full min-w-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={shares.rows}
                      dataKey="value"
                      nameKey="platform"
                      innerRadius="58%"
                      outerRadius="88%"
                      paddingAngle={shares.rows.length > 1 ? 2 : 0}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {shares.rows.map((r) => (
                        <Cell key={r.platform} fill={COLOR[r.platform]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(v, name) => [fmtNum(Number(v)), LABEL[name as Platform] ?? String(name)]}
                      contentStyle={TIP_STYLE}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="shrink-0 space-y-1 text-xs">
                {shares.rows.map((r) => (
                  <li key={r.platform} className="flex items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: COLOR[r.platform] }}
                    />
                    <span className="mr-3">{LABEL[r.platform]}</span>
                    <span className="ml-auto font-medium tabular-nums">
                      {Math.round((r.value / shares.total) * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </Panel>
  );
}

// Одна карточка ряда: заголовок с итогом сверху, рисунок под ним ростом ~200px вместе с шапкой.
function Card({
  title,
  total,
  subtitle,
  legend,
  children,
}: {
  title: string;
  total?: string;
  subtitle?: string;
  legend?: { key: string; label: string; color: string }[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-50 min-w-0 flex-col gap-1 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{title}</p>
          {total && <p className="text-lg font-semibold tabular-nums tracking-tight">{total}</p>}
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {legend && legend.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {legend.map((l) => (
              <li key={l.key} className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: l.color }} />
                {l.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

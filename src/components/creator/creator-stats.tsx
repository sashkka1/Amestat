"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ExternalLinkIcon, ImageOffIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PeriodSelector } from "./period-selector";
import { DailyChart, VideoHistoryChart } from "./daily-chart";
import { createClient } from "@/lib/supabase/client";
import { setVideoOurs } from "@/lib/api/videos";
import {
  fromDateInputValue,
  resolvePeriod,
  toDateInputValue,
  type PeriodKey,
  type PeriodRange,
} from "@/lib/period";
import { describeVsMedian, median, sum } from "@/lib/stats";
import { fmtDate, fmtDateTime, fmtDelta, fmtNum } from "@/lib/format";
import type { Creator, DailyViews, VideoStats } from "@/lib/types";
import { cn } from "@/lib/utils";

// Пять счётчиков площадки; прирост за срок и текущее значение.
const METRICS = [
  { key: "views", label: "Просмотры" },
  { key: "likes", label: "Лайки" },
  { key: "comments", label: "Комментарии" },
  { key: "shares", label: "Репосты" },
  { key: "saves", label: "Сохранения" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];
type DeltaKey = `${MetricKey}_delta`;
type NowKey = `${MetricKey}_now`;

type SortKey = "published_at" | DeltaKey | "views_now" | "likes_now";
type SortDir = "asc" | "desc";

type Loaded = {
  // Ключ запроса: креатор и границы срока. Не совпал с текущим — идёт новая загрузка.
  key: string;
  range: PeriodRange;
  rows: VideoStats[];
  daily: DailyViews[];
  followersNow: number | null;
  followersBefore: number | null;
};

async function loadStats(key: string, creatorId: string, range: PeriodRange): Promise<Loaded> {
  const supabase = createClient();
  const p_from = range.from.toISOString();
  const p_to = range.to.toISOString();
  const [statsRes, dailyRes, snapToRes, snapFromRes, snapFirstInsideRes] = await Promise.all([
    supabase.rpc("video_stats_between", { p_creator: creatorId, p_from, p_to }),
    supabase.rpc("creator_daily_views", { p_creator: creatorId, p_from, p_to }),
    supabase
      .from("creator_snaps")
      .select("followers, taken_at")
      .eq("creator_id", creatorId)
      .lte("taken_at", p_to)
      .order("taken_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("creator_snaps")
      .select("followers, taken_at")
      .eq("creator_id", creatorId)
      .lte("taken_at", p_from)
      .order("taken_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Снимка до начала срока может не быть — история началась позже (у «Всё время» так
    // всегда). Тогда началом считается первый снимок внутри срока — как в функции по видео
    // (владелец, 2026-09-07: «первое решение — да»).
    supabase
      .from("creator_snaps")
      .select("followers, taken_at")
      .eq("creator_id", creatorId)
      .gt("taken_at", p_from)
      .lte("taken_at", p_to)
      .order("taken_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const error =
    statsRes.error ?? dailyRes.error ?? snapToRes.error ?? snapFromRes.error ?? snapFirstInsideRes.error;
  if (error) throw new Error(error.message);
  return {
    key,
    range,
    rows: statsRes.data ?? [],
    daily: dailyRes.data ?? [],
    followersNow: snapToRes.data?.followers ?? null,
    followersBefore: snapFromRes.data?.followers ?? snapFirstInsideRes.data?.followers ?? null,
  };
}

function publishedIn(row: VideoStats, range: PeriodRange): boolean {
  if (!row.published_at) return false;
  const t = new Date(row.published_at).getTime();
  return t >= range.from.getTime() && t <= range.to.getTime();
}

export function CreatorStats({
  creator,
  refreshKey,
}: {
  creator: Creator;
  // Меняется снаружи (обход закончился, креатора отредактировали) — данные перечитываются.
  refreshKey: number;
}) {
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [customFrom, setCustomFrom] = useState(() =>
    toDateInputValue(new Date(Date.now() - 7 * 86_400_000)),
  );
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));

  // Границы срока пересчитываются только при смене выбора; «сейчас» берётся в этот момент.
  const range = useMemo(
    () =>
      resolvePeriod(period, new Date(), new Date(creator.added_at), {
        from: fromDateInputValue(customFrom),
        to: fromDateInputValue(customTo),
      }),
    [period, customFrom, customTo, creator.added_at],
  );

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("views_delta");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fromMs = range?.from.getTime();
  const toMs = range?.to.getTime();
  const key = range ? `${creator.id}|${fromMs}|${toMs}|${refreshKey}` : null;
  useEffect(() => {
    if (key === null || fromMs === undefined || toMs === undefined) return;
    let alive = true;
    loadStats(key, creator.id, { from: new Date(fromMs), to: new Date(toMs) }).then(
      (d) => {
        if (alive) setLoaded(d);
      },
      (e: unknown) => {
        if (alive) setFailed({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [key, creator.id, fromMs, toMs]);

  const error = failed !== null && failed.key === key ? failed.error : null;
  const loading = error === null && (loaded === null || loaded.key !== key);

  // Переключатель «наше»: строка меняется сразу, база — следом; не вышло — откат.
  async function toggleOurs(videoId: string, on: boolean) {
    setLoaded((prev) =>
      prev
        ? { ...prev, rows: prev.rows.map((r) => (r.video_id === videoId ? { ...r, ours: on } : r)) }
        : prev,
    );
    const res = await setVideoOurs(videoId, on);
    if (!res.ok) {
      toast.error(res.error);
      setLoaded((prev) =>
        prev
          ? { ...prev, rows: prev.rows.map((r) => (r.video_id === videoId ? { ...r, ours: !on } : r)) }
          : prev,
      );
    }
  }

  const summary = useMemo(() => {
    if (!loaded) return null;
    const { rows, range } = loaded;
    const ours = rows.filter((r) => r.ours);
    // «За срок»: видео, которое в этот срок хоть что-то набрало или вышло.
    const active = ours.filter((r) => r.views_delta > 0 || publishedIn(r, range));
    const totals = Object.fromEntries(
      METRICS.map((m) => [m.key, sum(ours.map((r) => r[`${m.key}_delta` as DeltaKey]))]),
    ) as Record<MetricKey, number>;
    const medPeriod = Object.fromEntries(
      METRICS.map((m) => [m.key, median(active.map((r) => r[`${m.key}_delta` as DeltaKey]))]),
    ) as Record<MetricKey, number | null>;
    const medTotal = {
      views: median(ours.map((r) => r.views_now)),
      likes: median(ours.map((r) => r.likes_now)),
    };
    const followersDelta =
      loaded.followersNow !== null && loaded.followersBefore !== null
        ? loaded.followersNow - loaded.followersBefore
        : null;
    return {
      totals,
      published: ours.filter((r) => publishedIn(r, range)).length,
      oursCount: ours.length,
      activeCount: active.length,
      medPeriod,
      medTotal,
      followersDelta,
    };
  }, [loaded]);

  const sorted = useMemo(() => {
    if (!loaded) return [];
    const dir = sortDir === "asc" ? 1 : -1;
    return [...loaded.rows].sort((a, b) => {
      if (sortKey === "published_at") {
        // Без даты — в самый низ при сортировке по убыванию.
        const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
        const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
        return (ta - tb) * dir;
      }
      return ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir;
    });
  }, [loaded, sortKey, sortDir]);

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const selected = loaded?.rows.find((r) => r.video_id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <PeriodSelector
        value={period}
        onChange={setPeriod}
        customFrom={customFrom}
        customTo={customTo}
        onCustomChange={(f, t) => {
          setCustomFrom(f);
          setCustomTo(t);
        }}
      />

      {range === null ? (
        <p className="text-sm text-muted-foreground">
          Укажите обе даты: начало не позже конца.
        </p>
      ) : error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Не удалось посчитать статистику: {error}
        </p>
      ) : !loaded || !summary ? (
        <StatsSkeleton />
      ) : (
        <div className={cn("flex flex-col gap-5", loading && "opacity-60 transition-opacity")}>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {METRICS.map((m) => (
              <Tile key={m.key} label={m.label} value={fmtDelta(summary.totals[m.key])} />
            ))}
            <Tile label="Видео за срок" value={fmtNum(summary.published)} />
            <Tile
              label="Подписчики"
              value={fmtNum(loaded.followersNow)}
              hint={summary.followersDelta !== null ? fmtDelta(summary.followersDelta) : "—"}
            />
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-medium">Медиана по видео за срок</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Наши видео, которые за срок вышли или набрали просмотры: {summary.activeCount}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Stat label="Просмотры" value={fmtNum(summary.medPeriod.views)} />
                <Stat label="Лайки" value={fmtNum(summary.medPeriod.likes)} />
              </dl>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-medium">Медиана всего</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                По всем нашим видео с данными: {summary.oursCount}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Stat label="Просмотры" value={fmtNum(summary.medTotal.views)} />
                <Stat label="Лайки" value={fmtNum(summary.medTotal.likes)} />
              </dl>
            </div>
          </section>

          <section className="rounded-xl border bg-card p-4 shadow-sm">
            <h2 className="mb-2 text-sm font-medium">Просмотры наших видео по дням</h2>
            <DailyChart data={loaded.daily.map((d) => ({ day: d.day, views: d.views }))} />
          </section>

          {selected && (
            <VideoPanel
              row={selected}
              medians={summary.medPeriod}
              onClose={() => setSelectedId(null)}
            />
          )}

          <section className="rounded-xl border bg-card shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
              <h2 className="text-sm font-medium">Видео</h2>
              <p className="text-xs text-muted-foreground">
                Всего {loaded.rows.length}, наших {summary.oursCount}. Не наши — серым, в суммы не идут.
              </p>
            </div>
            {loaded.rows.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                Снимков за этот срок нет — данные появятся после обхода.
              </p>
            ) : (
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12" />
                    <TableHead>Видео</TableHead>
                    <SortHead k="published_at" label="Дата" sortKey={sortKey} dir={sortDir} onSort={onSort} />
                    {METRICS.map((m) => (
                      <SortHead
                        key={m.key}
                        k={`${m.key}_delta` as DeltaKey}
                        label={`${m.label} +`}
                        sortKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                    ))}
                    <SortHead k="views_now" label="Просмотры" sortKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortHead k="likes_now" label="Лайки" sortKey={sortKey} dir={sortDir} onSort={onSort} />
                    <TableHead className="text-center">Наше</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r) => (
                    <TableRow
                      key={r.video_id}
                      onClick={() => setSelectedId(r.video_id)}
                      data-state={r.video_id === selectedId ? "selected" : undefined}
                      className={cn("cursor-pointer", !r.ours && "text-muted-foreground opacity-60")}
                    >
                      <TableCell>
                        <Cover src={r.cover_url} size={40} />
                      </TableCell>
                      <TableCell className="max-w-[16rem] truncate whitespace-normal" title={r.caption}>
                        <span className="line-clamp-2">{r.caption || "без подписи"}</span>
                      </TableCell>
                      <TableCell>{fmtDate(r.published_at)}</TableCell>
                      {METRICS.map((m) => (
                        <TableCell key={m.key} className="text-right tabular-nums">
                          {fmtDelta(r[`${m.key}_delta` as DeltaKey])}
                        </TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums">{fmtNum(r.views_now)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.likes_now)}</TableCell>
                      <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={r.ours}
                          onCheckedChange={(v) => void toggleOurs(r.video_id, v === true)}
                          aria-label="Наше видео"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums tracking-tight">{value}</p>
      {hint !== undefined && <p className="text-xs text-muted-foreground tabular-nums">{hint} за срок</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function SortHead({
  k,
  label,
  sortKey,
  dir,
  onSort,
}: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = k === sortKey;
  return (
    <TableHead className={cn(k !== "published_at" && "text-right")}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {active &&
          (dir === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
      </button>
    </TableHead>
  );
}

// Обложка: адреса TikTok CDN протухают, поэтому при ошибке — заглушка.
function Cover({ src, size, className }: { src: string | null; size: number; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;
  if (!src || failed) {
    return (
      <div
        className={cn("flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground", className)}
        style={{ width: size, height: Math.round(size * 1.33) }}
      >
        <ImageOffIcon className="size-4" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={Math.round(size * 1.33)}
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className={cn("shrink-0 rounded-md bg-muted object-cover", className)}
      style={{ width: size, height: Math.round(size * 1.33) }}
    />
  );
}

// Выбранное видео: карточка, сравнение с медианами за срок и своя история по снимкам.
function VideoPanel({
  row,
  medians,
  onClose,
}: {
  row: VideoStats;
  medians: Record<MetricKey, number | null>;
  onClose: () => void;
}) {
  // История помнит, чьё она видео: сменилась строка — до ответа показываем скелет.
  const [loadedHistory, setLoadedHistory] = useState<{
    videoId: string;
    data: { t: string; views: number }[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    const videoId = row.video_id;
    void createClient()
      .from("video_snaps")
      .select("taken_at, views")
      .eq("video_id", videoId)
      .order("taken_at", { ascending: true })
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) setLoadedHistory({ videoId, data: null, error: error.message });
        else
          setLoadedHistory({
            videoId,
            data: (data ?? []).map((s) => ({ t: s.taken_at, views: s.views ?? 0 })),
            error: null,
          });
      });
    return () => {
      alive = false;
    };
  }, [row.video_id]);

  const current = loadedHistory?.videoId === row.video_id ? loadedHistory : null;
  const history = current?.data ?? null;
  const historyError = current?.error ?? null;

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex gap-4">
        <Cover src={row.cover_url} size={72} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{row.caption || "без подписи"}</p>
            <Button variant="ghost" size="icon-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть">
              <XIcon />
            </Button>
          </div>
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Открыть в TikTok
            <ExternalLinkIcon className="size-3" />
          </a>
          <p className="text-xs text-muted-foreground">
            опубликовано: {fmtDateTime(row.published_at)}
            {!row.ours && " · не наше"}
          </p>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Сравнение с медианой за срок</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Счётчик</TableHead>
              <TableHead className="text-right">Это видео</TableHead>
              <TableHead className="text-right">Медиана</TableHead>
              <TableHead className="text-right">Итог</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {METRICS.map((m) => {
              const value = row[`${m.key}_delta` as DeltaKey];
              const now = row[`${m.key}_now` as NowKey];
              return (
                <TableRow key={m.key}>
                  <TableCell>{m.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtDelta(value)}
                    <span className="text-muted-foreground"> · всего {fmtNum(now)}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(medians[m.key])}</TableCell>
                  <TableCell className="text-right">{describeVsMedian(value, medians[m.key])}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Просмотры по снимкам</h3>
        {historyError ? (
          <p className="text-xs text-destructive">Не удалось прочитать снимки: {historyError}</p>
        ) : history === null ? (
          <Skeleton className="h-36 w-full" />
        ) : (
          <VideoHistoryChart data={history} />
        )}
      </div>
    </section>
  );
}

function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// Срок → границы p_from/p_to. Считается в часовом поясе того, кто вызывает
// (в браузере — местный), поэтому «сегодня» — с начала местных суток.

import { tr } from "@/lib/i18n";

export type PeriodKey = "today" | "7d" | "30d" | "all" | "custom";

const LABEL_KEY: Record<
  PeriodKey,
  "period.today" | "period.7d" | "period.30d" | "period.all" | "period.custom"
> = {
  today: "period.today",
  "7d": "period.7d",
  "30d": "period.30d",
  all: "period.all",
  custom: "period.custom",
};

export function periodLabel(key: PeriodKey): string {
  return tr(LABEL_KEY[key]);
}

export type PeriodRange = { from: Date; to: Date };

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function resolvePeriod(
  key: PeriodKey,
  now: Date,
  addedAt: Date,
  custom?: { from: Date | null; to: Date | null },
): PeriodRange | null {
  switch (key) {
    case "today":
      return { from: startOfLocalDay(now), to: now };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
    case "all":
      return { from: addedAt, to: now };
    case "custom": {
      if (!custom?.from || !custom?.to) return null;
      const from = startOfLocalDay(custom.from);
      const to = endOfLocalDay(custom.to);
      if (from > to) return null;
      return { from, to: to > now ? now : to };
    }
  }
}

// Прошлый срок той же длины, впритык перед нынешним: с ним сравниваются плитки.
export function previousRange(range: PeriodRange): PeriodRange {
  const len = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - len), to: new Date(range.from.getTime()) };
}

// Значение для <input type="date"> в местном поясе (YYYY-MM-DD).
export function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromDateInputValue(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

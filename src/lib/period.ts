// Срок → границы p_from/p_to. Считается в часовом поясе того, кто вызывает
// (в браузере — местный), поэтому «сегодня» — с начала местных суток.

export type PeriodKey = "today" | "7d" | "30d" | "all" | "custom";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Сегодня",
  "7d": "7 дней",
  "30d": "30 дней",
  all: "Всё время",
  custom: "Свой срок",
};

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

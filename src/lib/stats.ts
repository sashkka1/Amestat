// Чистая арифметика для статистики. Без зависимостей.

export function sum(values: Iterable<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

// Медиана; пустой набор → null. null/undefined внутри не считаются.
export function median(values: Iterable<number | null | undefined>): number | null {
  const nums: number[] = [];
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
  if (nums.length === 0) return null;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// Доля значения от медианы в процентах; медианы нет или ноль → null.
export function percentOfMedian(value: number, med: number | null): number | null {
  if (med === null || med === 0) return null;
  return (value / med) * 100;
}

// Человеческая формулировка сравнения с медианой:
// ниже или около — «x% от медианы», заметно выше — «в N раз выше».
export function describeVsMedian(value: number, med: number | null): string {
  const pct = percentOfMedian(value, med);
  if (pct === null) return med === 0 && value > 0 ? "медиана — 0" : "—";
  if (pct >= 200) {
    const times = value / (med as number);
    const rounded = times >= 10 ? Math.round(times) : Math.round(times * 10) / 10;
    return `в ${rounded.toLocaleString("ru-RU")} раз выше`;
  }
  return `${Math.round(pct)}% от медианы`;
}

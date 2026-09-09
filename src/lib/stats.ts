// Арифметика для статистики. Из зависимостей — только словарь: последняя функция здесь
// складывает фразу для человека.

import { getLang, localeOf, tr } from "@/lib/i18n";

export function sum(values: Iterable<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

// Бегущая сумма ряда: дневные приросты → «накопительно от начала срока».
//
// ⚠️ База отдаёт дневные ряды уже приростом (миграция v20), поэтому обратного действия —
// разности соседних дней — на клиенте нет нигде. Раньше их было три копии, и каждая
// засчитывала первый день видео его полной историей.
export function runningTotal(values: number[]): number[] {
  let acc = 0;
  return values.map((v) => (acc += v));
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
  if (pct === null) return med === 0 && value > 0 ? tr("stats.medianZero") : "—";
  if (pct >= 200) {
    const times = value / (med as number);
    const rounded = times >= 10 ? Math.round(times) : Math.round(times * 10) / 10;
    return tr("stats.timesHigher", { n: rounded.toLocaleString(localeOf(getLang())) });
  }
  return tr("stats.pctOfMedian", { n: Math.round(pct) });
}

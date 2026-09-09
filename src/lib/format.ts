// Форматирование чисел и дат. Локаль берётся из выбранного языка (`lib/i18n`): русский —
// `ru-RU`, английский — `en-US`, португальский — `pt-BR`.
//
// ⚠️ Язык читается вне React (getLang), поэтому сам по себе он перерисовку не вызывает:
// страница обязана быть подписана на язык через useT/useLang, и тогда всё под ней
// пересчитается вместе с ней. У всех страниц сайта подписка есть — заголовок и подпись
// страницы переводятся тем же хуком.

import { getLang, localeOf, monthsShort, tr } from "@/lib/i18n";

function locale(): string {
  return localeOf(getLang());
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString(locale());
}

export function fmtDelta(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return (n > 0 ? "+" : "") + n.toLocaleString(locale());
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric" });
}

// «13:05» — время без даты: журнал обхода и его шапка идут внутри одного дня.
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

// «13:05:41» — метка строки журнала: секунды там важны, строки идут по несколько в минуту.
export function fmtTimeSec(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Короткие месяцы — из словаря, а не из Intl: тот добавляет точку и «г.», а подпись оси
// должна быть ровно «12 авг».
function months(): string[] {
  return monthsShort(getLang());
}

// «12 авг» — подпись оси и даты в карточках.
export function fmtDayAxis(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${months()[d.getMonth()]}`;
}

// «10 авг 2026» — концы срока в пилюле выбора.
// «8 сентября» — день с месяцем словом, без года: так читается оговорка под полосой периода.
// Месяц берётся у Intl, а не из словаря: в русском здесь нужен родительный падеж, которого
// у коротких `monthsShort` нет.
export function fmtDayLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale(), { day: "numeric", month: "long" });
}

export function fmtDayYear(d: Date): string {
  return `${d.getDate()} ${months()[d.getMonth()]} ${d.getFullYear()}`;
}

// Короткое число: 942, 37,8K, 1,2M. Пусто — «—». Разделитель дробной части — из локали.
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 1000) return sign + String(Math.round(a));
  const unit = a < 1_000_000 ? "K" : a < 1_000_000_000 ? "M" : "B";
  const div = a < 1_000_000 ? 1000 : a < 1_000_000_000 ? 1_000_000 : 1_000_000_000;
  const v = a / div;
  const s = (v < 100 ? v.toFixed(1) : String(Math.round(v))).replace(/\.0$/, "").replace(".", decimalSep());
  return `${sign}${s}${unit}`;
}

// Какой знак у дробной части в этой локали: «,» у русского и португальского, «.» у английского.
function decimalSep(): string {
  return (1.1).toLocaleString(locale()).replace(/\d/g, "");
}

export type Change = { text: string; tone: "up" | "down" | "flat" };

// Разница с прошлым в процентах, округлённая: до десятых у мелких изменений, до целых у
// крупных. null — прошлое ноль, сравнивать не с чем.
function roundedPct(now: number, prev: number): number | null {
  if (prev === 0) return null;
  const pct = ((now - prev) / prev) * 100;
  return Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
}

function toneOf(rounded: number): Change["tone"] {
  return rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
}

// Сравнение с прошлым сроком той же длины. Прошлое — ноль: сравнивать не с чем.
export function changeVs(now: number, prev: number): Change {
  const rounded = roundedPct(now, prev);
  if (rounded === null) return { text: "—", tone: "flat" };
  const sign = rounded > 0 ? "+" : "";
  const text = tr("format.vsPrev", { pct: `${sign}${rounded.toLocaleString(locale())}` });
  return { text, tone: toneOf(rounded) };
}

// То же сравнение, но без слов — «+12%». Для ячейки таблицы, где на фразу «к прошлому
// периоду» места нет, а колонка и так про неё.
export function changePct(now: number, prev: number): Change {
  const rounded = roundedPct(now, prev);
  if (rounded === null) return { text: "—", tone: "flat" };
  const sign = rounded > 0 ? "+" : "";
  return { text: `${sign}${rounded.toLocaleString(locale())}%`, tone: toneOf(rounded) };
}

// Вовлечённость видео в процентах: (лайки + комментарии + репосты) / просмотры.
export function engagementPct(likes: number, comments: number, shares: number, views: number): string {
  if (!views) return "—";
  const v = ((likes + comments + shares) / views) * 100;
  return `${(Math.round(v * 10) / 10).toLocaleString(locale())}%`;
}

export function fmtDayShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

// Инициалы для заглушки аватара.
export function initials(name: string): string {
  const parts = name.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Читаемый цвет текста поверх фона #RRGGBB.
export function textOn(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return "#111";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

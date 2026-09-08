// Форматирование чисел и дат по-русски.

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("ru-RU");
}

export function fmtDelta(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return (n > 0 ? "+" : "") + n.toLocaleString("ru-RU");
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
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
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

// «12 авг» — подпись оси и даты в карточках.
export function fmtDayAxis(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// «10 авг 2026» — концы срока в пилюле выбора.
export function fmtDayYear(d: Date): string {
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// Короткое число: 942, 37,8K, 1,2M. Пусто — «—».
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 1000) return sign + String(Math.round(a));
  const unit = a < 1_000_000 ? "K" : a < 1_000_000_000 ? "M" : "B";
  const div = a < 1_000_000 ? 1000 : a < 1_000_000_000 ? 1_000_000 : 1_000_000_000;
  const v = a / div;
  const s = (v < 100 ? v.toFixed(1) : String(Math.round(v))).replace(/\.0$/, "").replace(".", ",");
  return `${sign}${s}${unit}`;
}

export type Change = { text: string; tone: "up" | "down" | "flat" };

// Сравнение с прошлым сроком той же длины. Прошлое — ноль: сравнивать не с чем.
export function changeVs(now: number, prev: number): Change {
  if (prev === 0) return { text: "—", tone: "flat" };
  const pct = ((now - prev) / prev) * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const text = `${sign}${rounded.toLocaleString("ru-RU")}% к прошлому периоду`;
  return { text, tone: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat" };
}

// Вовлечённость видео в процентах: (лайки + комментарии + репосты) / просмотры.
export function engagementPct(likes: number, comments: number, shares: number, views: number): string {
  if (!views) return "—";
  const v = ((likes + comments + shares) / views) * 100;
  return `${(Math.round(v * 10) / 10).toLocaleString("ru-RU")}%`;
}

export function fmtDayShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
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

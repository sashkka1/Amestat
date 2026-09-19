// Деньги креаторам. 🔴 ОДНА формула на весь проект и живёт она здесь: база (миграция v37)
// отдаёт только просмотры на отметке окна, а сколько это в долларах — считается тут и нигде
// больше. Вторая копия формулы разошлась бы с первой молча, и разница вылезла бы платежом.
//
// Что за что платится (владелец, 2026-09-19):
//   Base        — за сам факт опубликованного видео;
//   Bonus       — за тысячу просмотров, но только от Min Bonus Threshold и только до Max;
//   Extra Bonus — разовая надбавка, если просмотров стало БОЛЬШЕ Max (ровно 100 000 — ещё нет).
// Просмотры берутся на отметке «публикация + Calculation Window», а не текущие: платим за
// первые трое суток, дальше видео живёт только в статистике.

import type { Payment, PaymentRules, PaymentStat } from "./types";

// Те же значения, что в `default` колонок `payment_rules`. Нужны ровно на один случай:
// строки ставок у креатора почему-то нет (её заводит триггер базы). Считать по нулям было бы
// хуже — долг молча стал бы нулевым.
export const DEFAULT_RULES = {
  base: 3,
  bonus: 0.5,
  min_bonus_views: 500,
  max_bonus_views: 100_000,
  extra_bonus: 15,
  window_hours: 72,
  videos_threshold: 4,
} as const;

export function defaultRulesFor(creatorId: string): PaymentRules {
  return { creator_id: creatorId, ...DEFAULT_RULES, updated_at: "", updated_by: null };
}

// Состояние видео в расчёте.
//   final   — окно закрылось, обход после отметки был: сумма окончательная;
//   pending — окно ещё идёт (или обхода после отметки не было): сумма — оценка по текущим;
//   nodata  — внутри окна не было ни одного снимка: в деньги не идёт вовсе;
//   paid    — уже закрыто выплатой.
export type MoneyState = "final" | "pending" | "nodata" | "paid";

export type VideoMoney = {
  base: number;
  bonus: number;
  extra: number;
  total: number;
  // Просмотры, по которым посчитано: на отметке окна у окончательных, текущие у остальных.
  views: number | null;
  state: MoneyState;
  paymentId: number | null;
};

// Доллары округляются до цента на каждой части: в базе `numeric(12,2)`, и сумма, показанная
// на экране, обязана совпасть с той, что уйдёт в платёж.
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function videoMoney(stat: PaymentStat, rules: PaymentRules): VideoMoney {
  // Видео, которое сборщик не видел внутри окна, не считается вовсе (владелец, 2026-09-19:
  // «первоначально не будем считать статистику»). В порог `videos_threshold` оно при этом
  // входит — видео сделано.
  if (!stat.has_early) {
    return { base: 0, bonus: 0, extra: 0, total: 0, views: null, state: "nodata", paymentId: stat.payment_id };
  }

  const settled = stat.views_window !== null;
  const views = (settled ? stat.views_window : stat.views_now) ?? 0;

  const base = cents(rules.base);
  // Порог минимума — по принципу «не меньше»: 499 просмотров не платятся вовсе, 500 уже дают
  // свои полцента за сотню (владелец: «если 500, то уже 0,25»).
  const counted = views >= rules.min_bonus_views ? Math.min(views, rules.max_bonus_views) : 0;
  const bonus = cents((counted / 1000) * rules.bonus);
  // Надбавка — за ПЕРЕХОД потолка, поэтому строго «больше»: на 100 000 ровно платится только
  // потолок бонуса, на 100 001 — потолок и надбавка.
  const extra = views > rules.max_bonus_views ? cents(rules.extra_bonus) : 0;

  return {
    base,
    bonus,
    extra,
    total: cents(base + bonus + extra),
    views,
    state: stat.payment_id !== null ? "paid" : settled ? "final" : "pending",
    paymentId: stat.payment_id,
  };
}

// Сумма, разложенная по ставкам: столько-то за факт видео, столько-то за просмотры,
// столько-то надбавкой. Тем же набором колонок показывается и одно видео, и креатор целиком.
export type MoneyParts = { base: number; bonus: number; extra: number };

export function sumParts(rows: { base: number; bonus: number; extra: number }[]): MoneyParts {
  const p: MoneyParts = { base: 0, bonus: 0, extra: 0 };
  for (const r of rows) {
    p.base += r.base;
    p.bonus += r.bonus;
    p.extra += r.extra;
  }
  return { base: cents(p.base), bonus: cents(p.bonus), extra: cents(p.extra) };
}

export type CreatorMoney = {
  creatorId: string;
  rules: PaymentRules;
  // Сколько всего наших видео — по ним и считается порог: и «нет данных», и несозревшие.
  videos: number;
  videosFinal: number;
  videosPending: number;
  videosNoData: number;
  videosPaid: number;
  // Порог открыт — созревшие видео идут в долг; закрыт — всё висит в ожидании.
  gateOpen: boolean;
  videosToGate: number;
  // Сумма созревших и ещё не закрытых выплатой — и она же, разложенная по ставкам.
  // Разложение нужно таблице креаторов: владелец просил показывать «за что конкретно мы
  // платим» не только у видео, но и в остальных таблицах.
  payableTotal: number;
  payableParts: MoneyParts;
  // Сколько уже выплачено деньгами и на сколько закрыто видео: разница остаётся в долге.
  paidTotal: number;
  coveredTotal: number;
  // Долг сейчас и «в ожидании» — то, за что платить ещё рано.
  due: number;
  pendingTotal: number;
  // Заработано за всё время: выплаченное плюс то, что ещё должны.
  earnedTotal: number;
  lastPaidAt: string | null;
};

// Один креатор: его видео, его ставки, его выплаты.
//
// ⚠️ Долг считается балансом (владелец, 2026-09-19): «сумма уходит из финального в
// выплачено». Недоплата остаётся долгом, переплата уводит в минус — за это отвечает `carry`,
// разница между тем, на сколько закрыли видео, и тем, сколько заплатили.
export function creatorMoney(
  creatorId: string,
  stats: PaymentStat[],
  rules: PaymentRules | undefined,
  payments: Payment[],
): CreatorMoney {
  const r = rules ?? defaultRulesFor(creatorId);
  const mine = stats.filter((s) => s.creator_id === creatorId);
  const rows = mine.map((s) => videoMoney(s, r));

  let payableTotal = 0;
  let pendingOwn = 0;
  let videosFinal = 0;
  let videosPending = 0;
  let videosNoData = 0;
  let videosPaid = 0;
  for (const m of rows) {
    if (m.state === "paid") videosPaid += 1;
    else if (m.state === "nodata") videosNoData += 1;
    else if (m.state === "final") {
      videosFinal += 1;
      payableTotal += m.total;
    } else {
      videosPending += 1;
      pendingOwn += m.total;
    }
  }
  payableTotal = cents(payableTotal);
  pendingOwn = cents(pendingOwn);
  // Разложение по ставкам — по тем же видео, из которых сложился долг.
  const payableParts = sumParts(rows.filter((m) => m.state === "final"));

  const paidTotal = cents(payments.reduce((acc, p) => acc + p.amount, 0));
  const coveredTotal = cents(payments.reduce((acc, p) => acc + p.covered_total, 0));
  const carry = cents(coveredTotal - paidTotal);

  const gateOpen = mine.length >= r.videos_threshold;
  // Порог не набран — не платим ничего, даже за созревшие (владелец: «сделал три видео,
  // заработал сотни долларов — всё равно не выплачиваем, это в ожидании»).
  const due = cents(gateOpen ? payableTotal + carry : carry);
  const pendingTotal = cents(gateOpen ? pendingOwn : pendingOwn + payableTotal);

  const lastPaidAt = payments.reduce<string | null>(
    (last, p) => (last === null || p.paid_at > last ? p.paid_at : last),
    null,
  );

  return {
    creatorId,
    rules: r,
    videos: mine.length,
    videosFinal,
    videosPending,
    videosNoData,
    videosPaid,
    gateOpen,
    videosToGate: Math.max(r.videos_threshold - mine.length, 0),
    payableTotal,
    payableParts,
    paidTotal,
    coveredTotal,
    due,
    pendingTotal,
    earnedTotal: cents(paidTotal + due + pendingTotal),
    lastPaidAt,
  };
}

export type MoneyTotals = {
  paid: number;
  due: number;
  pending: number;
  creatorsDue: number;
  videosFinal: number;
  videosPending: number;
  videosNoData: number;
};

export function sumMoney(rows: CreatorMoney[]): MoneyTotals {
  const t: MoneyTotals = {
    paid: 0, due: 0, pending: 0, creatorsDue: 0,
    videosFinal: 0, videosPending: 0, videosNoData: 0,
  };
  for (const c of rows) {
    t.paid += c.paidTotal;
    t.due += c.due;
    t.pending += c.pendingTotal;
    if (c.due > 0) t.creatorsDue += 1;
    t.videosFinal += c.videosFinal;
    t.videosPending += c.videosPending;
    t.videosNoData += c.videosNoData;
  }
  t.paid = cents(t.paid);
  t.due = cents(t.due);
  t.pending = cents(t.pending);
  return t;
}

// Доллары для экрана. Своя функция, а не `fmtNum`: у денег всегда два знака и знак валюты,
// а у счётчиков площадок — ни того, ни другого.
export function fmtMoney(n: number | null | undefined): string {
  const v = n ?? 0;
  const sign = v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Что уйдёт в платёж: созревшие и ещё не закрытые видео этого креатора с замороженными
// суммами. Порог закрыт — платить нечего.
export type CoveredVideo = {
  video_id: string;
  base: number;
  bonus: number;
  extra: number;
  total: number;
  views: number | null;
};

export function coveredVideos(
  creatorId: string,
  stats: PaymentStat[],
  rules: PaymentRules | undefined,
): CoveredVideo[] {
  const r = rules ?? defaultRulesFor(creatorId);
  const mine = stats.filter((s) => s.creator_id === creatorId);
  if (mine.length < r.videos_threshold) return [];
  const out: CoveredVideo[] = [];
  for (const s of mine) {
    const m = videoMoney(s, r);
    if (m.state !== "final") continue;
    out.push({ video_id: s.video_id, base: m.base, bonus: m.bonus, extra: m.extra, total: m.total, views: m.views });
  }
  return out;
}

"use client";

import { useMemo, useState } from "react";
import {
  BanknoteIcon,
  ClockIcon,
  EyeOffIcon,
  UsersIcon,
  VideoIcon,
  WalletIcon,
} from "lucide-react";
import { AuthGate } from "@/components/auth-gate";
import { Avatar } from "@/components/avatar";
import { CreatorLabel } from "@/components/creator-label";
import { GONE_IMAGE_CLASS } from "@/components/gone-mark";
import { LocalTime } from "@/components/local-time";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreatorPaymentSheet } from "@/components/payments/creator-sheet";
import { MoneyTiles, type MoneyTile } from "@/components/payments/money-tiles";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { creatorMoney, fmtMoney, sumMoney, type CreatorMoney } from "@/lib/payment";
import {
  listCreators,
  listPaymentRules,
  listPaymentVideos,
  listPayments,
  paymentStats,
} from "@/lib/queries";
import { useLoader } from "@/lib/use-loader";
import type { Creator, Payment, PaymentRules, PaymentStat, PaymentVideo } from "@/lib/types";
import { cn } from "@/lib/utils";

// Вкладка «Payments» — только у администратора (владелец, 2026-09-19). Срока у страницы нет
// намеренно: долг считается за всё время, а не за выбранный период, поэтому ни полосы
// периода, ни переключателя площадки здесь не стоит.
//
// Числа берутся из `payment_stats` (миграция v37), а деньги считает `lib/payment.ts` — одна
// формула на весь сайт.

type Data = {
  creators: Creator[];
  stats: PaymentStat[];
  rules: PaymentRules[];
  payments: Payment[];
  covers: PaymentVideo[];
};

async function loadPayments(): Promise<Data> {
  const [creators, stats, rules, payments, covers] = await Promise.all([
    listCreators(),
    paymentStats(),
    listPaymentRules(),
    listPayments(),
    listPaymentVideos(),
  ]);
  return { creators, stats, rules, payments, covers };
}

export default function PaymentsPage() {
  return (
    <AuthGate role="admin">
      <PaymentsScreen />
    </AuthGate>
  );
}

function PaymentsScreen() {
  const t = useT();
  const { data, error, loading, reload } = useLoader(loadPayments, []);
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!data) return [];
    const byCreator = new Map(data.rules.map((r) => [r.creator_id, r]));
    return data.creators
      .map((creator) => ({
        creator,
        money: creatorMoney(
          creator.id,
          data.stats,
          byCreator.get(creator.id),
          data.payments.filter((p) => p.creator_id === creator.id),
        ),
      }))
      // Сверху те, кому должны: страница отвечает на вопрос «кому платить сейчас».
      .sort(
        (a, b) =>
          b.money.due - a.money.due ||
          b.money.pendingTotal - a.money.pendingTotal ||
          (a.creator.display_name || a.creator.handle).localeCompare(
            b.creator.display_name || b.creator.handle,
          ),
      );
  }, [data]);

  const totals = useMemo(() => sumMoney(rows.map((r) => r.money)), [rows]);

  const tiles: MoneyTile[] = [
    { key: "paid", label: t("payments.paidTotal"), value: fmtMoney(totals.paid), icon: WalletIcon },
    {
      key: "due",
      label: t("payments.dueNow"),
      value: fmtMoney(totals.due),
      icon: BanknoteIcon,
      tone: totals.due > 0 ? "due" : "plain",
    },
    { key: "pending", label: t("payments.pending"), value: fmtMoney(totals.pending), icon: ClockIcon },
    {
      key: "creators",
      label: t("payments.creatorsDue"),
      value: fmtNum(totals.creatorsDue),
      icon: UsersIcon,
    },
    {
      key: "final",
      label: t("payments.videosFinal"),
      value: fmtNum(totals.videosFinal),
      icon: VideoIcon,
      hint: t("payments.videosInWindow") + ": " + fmtNum(totals.videosPending),
    },
    {
      key: "nodata",
      label: t("payments.videosNoData"),
      value: fmtNum(totals.videosNoData),
      icon: EyeOffIcon,
      hint: t("payments.stateNoDataHint"),
    },
  ];

  const open = rows.find((r) => r.creator.id === openId) ?? null;

  return (
    <Page title={t("payments.title")} subtitle={t("payments.subtitle")}>
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton blocks={1} />
      ) : (
        <>
          <MoneyTiles items={tiles} />
          <Panel>
            <PanelHead title={t("payments.tableTitle")} />
            {rows.length === 0 ? (
              <Empty>{t("payments.empty")}</Empty>
            ) : (
              <Table className="border-t">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("payments.colCreator")}</TableHead>
                    <TableHead className="text-right">{t("payments.colVideos")}</TableHead>
                    <TableHead className="text-right">{t("payments.colPaid")}</TableHead>
                    <TableHead className="text-right">{t("payments.colPending")}</TableHead>
                    {/* Три ставки отдельными колонками — из них складывается долг справа
                        (владелец: «по каждой колонке за что конкретно мы платим»). */}
                    <TableHead className="text-right">{t("payments.colBase")}</TableHead>
                    <TableHead className="text-right">{t("payments.colBonus")}</TableHead>
                    <TableHead className="text-right">{t("payments.colExtra")}</TableHead>
                    <TableHead className="text-right">{t("payments.colDue")}</TableHead>
                    <TableHead>{t("payments.colLastPaid")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ creator, money }) => (
                    <CreatorRow
                      key={creator.id}
                      creator={creator}
                      money={money}
                      onOpen={() => setOpenId(creator.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </>
      )}

      {open && data && (
        <CreatorPaymentSheet
          creator={open.creator}
          money={open.money}
          stats={data.stats.filter((s) => s.creator_id === open.creator.id)}
          payments={data.payments.filter((p) => p.creator_id === open.creator.id)}
          covers={data.covers.filter((c) =>
            data.payments.some((p) => p.id === c.payment_id && p.creator_id === open.creator.id),
          )}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      )}
    </Page>
  );
}

// Строка креатора. Вся строка — кнопка: по щелчку открывается попап с его ставками, видео и
// историей выплат (владелец: «по нажатию на креатора будет открываться попап»).
function CreatorRow({
  creator,
  money,
  onOpen,
}: {
  creator: Creator;
  money: CreatorMoney;
  onOpen: () => void;
}) {
  const t = useT();
  const name = creator.display_name || creator.handle;
  return (
    <TableRow className="cursor-pointer" onClick={onOpen} tabIndex={0} role="button"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <TableCell>
        <span className="flex items-center gap-2">
          <Avatar
            src={creator.avatar_url}
            name={name}
            size={28}
            className={creator.gone_at ? GONE_IMAGE_CLASS : undefined}
          />
          <CreatorLabel platform={creator.platform} name={creator.display_name} handle={creator.handle} />
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtNum(money.videos)}
        {!money.gateOpen && (
          <span className="ml-1 text-xs text-muted-foreground">
            ({t("payments.gateLeft", { n: money.videosToGate })})
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {fmtMoney(money.paidTotal)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {fmtMoney(money.pendingTotal)}
      </TableCell>
      {/* Порог не набран — платить нечего, и прочерк честнее нуля: сумма у креатора есть,
          просто она вся в ожидании. */}
      {(["base", "bonus", "extra"] as const).map((part) => (
        <TableCell key={part} className="text-right tabular-nums text-muted-foreground">
          {money.gateOpen ? fmtMoney(money.payableParts[part]) : "—"}
        </TableCell>
      ))}
      <TableCell className={cn("text-right font-medium tabular-nums", money.due > 0 && "text-[var(--up)]")}>
        {fmtMoney(money.due)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {money.lastPaidAt ? <LocalTime iso={money.lastPaidAt} mode="date" /> : t("payments.never")}
      </TableCell>
    </TableRow>
  );
}

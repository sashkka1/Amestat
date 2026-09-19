"use client";

import { useState } from "react";
import { FileTextIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalTime } from "@/components/local-time";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Button } from "@/components/ui/button";
import { receiptUrl } from "@/lib/api/payments";
import { fmtMoney, sumParts } from "@/lib/payment";
import { useT } from "@/lib/i18n";
import type { Payment, PaymentVideo } from "@/lib/types";

// История выплат креатору: когда, сколько и за что. «За что» — это замороженные суммы
// закрытых видео (`payment_videos`), поэтому число рядом с платежом не меняется, даже если
// ставку креатора потом поправили.
export function PaymentHistory({
  payments,
  covers,
}: {
  payments: Payment[];
  covers: PaymentVideo[];
}) {
  const t = useT();
  const [busy, setBusy] = useState<number | null>(null);

  async function openDoc(payment: Payment) {
    setBusy(payment.id);
    try {
      const res = await receiptUrl(payment.doc_path);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Бакет приватный: ссылка подписана на час и открывается новой вкладкой.
      window.open(res.data, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel>
      <PanelHead title={t("payments.historyTitle")} />
      {payments.length === 0 ? (
        <Empty>{t("payments.historyEmpty")}</Empty>
      ) : (
        <ul className="flex flex-col divide-y border-t">
          {payments.map((p) => {
            const mine = covers.filter((c) => c.payment_id === p.id);
            const n = mine.length;
            // «С подробностями за что» (владелец): не только сколько видео, но и из каких
            // ставок сложилась сумма. Числа замороженные — те, что были в день выплаты.
            const parts = sumParts(mine);
            return (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium tabular-nums">{fmtMoney(p.amount)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    <LocalTime iso={p.paid_at} mode="date" />
                    {n > 0 && ` · ${t("payments.historyFor", { n, videos: t.plural("videos", n) })}`}
                    {/* Заплатили не ровно столько, во сколько встали видео, — показываем расчёт
                        рядом: иначе разница в долге выглядела бы ошибкой. */}
                    {p.covered_total !== p.amount &&
                      ` · ${t("payments.historyDiff", { sum: fmtMoney(p.covered_total) })}`}
                    {p.created_by_login && ` · ${t("payments.historyBy", { login: p.created_by_login })}`}
                  </p>
                  {n > 0 && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t("payments.colBase")} {fmtMoney(parts.base)} · {t("payments.colBonus")}{" "}
                      {fmtMoney(parts.bonus)} · {t("payments.colExtra")} {fmtMoney(parts.extra)}
                    </p>
                  )}
                  {p.note && <p className="truncate text-xs text-muted-foreground">{p.note}</p>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openDoc(p)}
                  disabled={busy === p.id}
                  title={p.doc_name || t("payments.historyDoc")}
                >
                  <FileTextIcon data-icon="inline-start" />
                  {t("payments.historyDoc")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

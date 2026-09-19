"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { recordPayment, uploadReceipt } from "@/lib/api/payments";
import { fmtMoney, type CoveredVideo } from "@/lib/payment";
import { useT } from "@/lib/i18n";

// Запись выплаты. Документ обязателен (владелец, 2026-09-19: «если документ загружен, то
// считаем сумму оплаченной»), сумма подставляется расчётная и правится руками — заплатить
// можно и меньше, тогда остаток останется долгом.
//
// ⚠️ Порядок важен: сначала файл в бакет, потом запись платежа. Упадёт запись — в бакете
// останется лишний файл, и это не беда; упади наоборот — в истории был бы платёж без чека.
export function PayDialog({
  open,
  onOpenChange,
  creatorId,
  creatorName,
  due,
  covered,
  onPaid,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  creatorId: string;
  creatorName: string;
  due: number;
  covered: CoveredVideo[];
  onPaid: () => void;
}) {
  const t = useT();
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Окно открыли — подставили расчётный долг заново: за время на странице он мог измениться.
  // Правка состояния прямо в теле рендера, а не эффектом: это тот самый случай «сбросить
  // состояние при смене свойства», который React рекомендует делать так, и заодно
  // единственный, который не гонит лишний круг перерисовки.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAmount(due > 0 ? due.toFixed(2) : "");
      setFile(null);
      setNote("");
    }
  }

  const coveredTotal = covered.reduce((acc, v) => acc + v.total, 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount.trim().replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      toast.error(t("payments.payBadAmount"));
      return;
    }
    if (!file) {
      toast.error(t("payments.payNeedDoc"));
      return;
    }
    setBusy(true);
    try {
      const up = await uploadReceipt(creatorId, file);
      if (!up.ok) {
        toast.error(up.error);
        return;
      }
      const res = await recordPayment({
        creatorId,
        amount: Math.round(value * 100) / 100,
        docPath: up.data.path,
        docName: up.data.name,
        note: note.trim(),
        videos: covered,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(t("payments.paid"));
      onOpenChange(false);
      onPaid();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("payments.payTitle", { name: creatorName })}</DialogTitle>
          <DialogDescription>
            {covered.length > 0
              ? t("payments.payCovers", {
                  n: covered.length,
                  videos: t.plural("videos", covered.length),
                  sum: fmtMoney(coveredTotal),
                })
              : t("payments.payNothing")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-amount">{t("payments.payAmount")}</Label>
            <Input
              id="pay-amount"
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              className="tabular-nums"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-doc">{t("payments.payDoc")}</Label>
            <Input
              id="pay-doc"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">{t("payments.payDocHint")}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-note">{t("payments.payNote")}</Label>
            <Textarea id="pay-note" value={note} rows={2} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.saving") : t("payments.paySubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

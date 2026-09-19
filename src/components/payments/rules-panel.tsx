"use client";

import { useState } from "react";
import { PencilIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelHead } from "@/components/stats/panel";
import { savePaymentRules } from "@/lib/api/payments";
import { DEFAULT_RULES, fmtMoney } from "@/lib/payment";
import { fmtNum } from "@/lib/format";
import { useT, type TKey } from "@/lib/i18n";
import type { PaymentRules, PaymentRulesUpdate } from "@/lib/types";

// Ставки одного креатора. Общих на весь сайт нет: у каждого своя строка (владелец,
// 2026-09-19: «все личные у каждого креатора… в случае чего я поменяю»). Кнопка «Reset»
// возвращает не чужие ставки, а те же значения по умолчанию, с которыми креатор заводился.

type Field = {
  key: keyof typeof DEFAULT_RULES;
  label: TKey;
  hint: TKey;
  kind: "money" | "views" | "hours" | "count";
};

const FIELDS: Field[] = [
  { key: "base", label: "payments.base", hint: "payments.baseHint", kind: "money" },
  { key: "bonus", label: "payments.bonus", hint: "payments.bonusHint", kind: "money" },
  { key: "min_bonus_views", label: "payments.minBonus", hint: "payments.minBonusHint", kind: "views" },
  { key: "max_bonus_views", label: "payments.maxBonus", hint: "payments.maxBonusHint", kind: "views" },
  { key: "extra_bonus", label: "payments.extraBonus", hint: "payments.extraBonusHint", kind: "money" },
  { key: "window_hours", label: "payments.window", hint: "payments.windowHint", kind: "hours" },
  { key: "videos_threshold", label: "payments.threshold", hint: "payments.thresholdHint", kind: "count" },
];

type Draft = Record<keyof typeof DEFAULT_RULES, string>;

function draftOf(rules: PaymentRules): Draft {
  return {
    base: String(rules.base),
    bonus: String(rules.bonus),
    min_bonus_views: String(rules.min_bonus_views),
    max_bonus_views: String(rules.max_bonus_views),
    extra_bonus: String(rules.extra_bonus),
    window_hours: String(rules.window_hours),
    videos_threshold: String(rules.videos_threshold),
  };
}

function defaultsDraft(): Draft {
  return {
    base: String(DEFAULT_RULES.base),
    bonus: String(DEFAULT_RULES.bonus),
    min_bonus_views: String(DEFAULT_RULES.min_bonus_views),
    max_bonus_views: String(DEFAULT_RULES.max_bonus_views),
    extra_bonus: String(DEFAULT_RULES.extra_bonus),
    window_hours: String(DEFAULT_RULES.window_hours),
    videos_threshold: String(DEFAULT_RULES.videos_threshold),
  };
}

// Разбор одного поля: запятая вместо точки — обычная опечатка, а не повод отказать.
function num(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Проверка ровно та же, что стоит ограничением `payment_rules_sane` в базе: отказ от базы
// приходит без внятного текста, и ловить такое лучше на экране.
function parse(draft: Draft): PaymentRulesUpdate | null {
  const base = num(draft.base);
  const bonus = num(draft.bonus);
  const minViews = num(draft.min_bonus_views);
  const maxViews = num(draft.max_bonus_views);
  const extra = num(draft.extra_bonus);
  const hours = num(draft.window_hours);
  const threshold = num(draft.videos_threshold);
  if (base === null || bonus === null || minViews === null || maxViews === null) return null;
  if (extra === null || hours === null || threshold === null) return null;
  if (base < 0 || bonus < 0 || extra < 0 || minViews < 0 || threshold < 0) return null;
  if (maxViews < minViews || hours <= 0) return null;
  return {
    base: Math.round(base * 100) / 100,
    bonus: Math.round(bonus * 100) / 100,
    extra_bonus: Math.round(extra * 100) / 100,
    min_bonus_views: Math.round(minViews),
    max_bonus_views: Math.round(maxViews),
    window_hours: Math.round(hours),
    videos_threshold: Math.round(threshold),
  };
}

export function RulesPanel({
  creatorId,
  rules,
  onSaved,
}: {
  creatorId: string;
  rules: PaymentRules;
  onSaved: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(rules));
  const [busy, setBusy] = useState(false);

  function start() {
    setDraft(draftOf(rules));
    setEditing(true);
  }

  async function save() {
    const values = parse(draft);
    if (!values) {
      toast.error(t("payments.badNumbers"));
      return;
    }
    setBusy(true);
    try {
      const res = await savePaymentRules(creatorId, values);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(t("payments.rulesSaved"));
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  function shown(field: Field): string {
    const value = rules[field.key];
    switch (field.kind) {
      case "money":
        return fmtMoney(value);
      case "views":
        return fmtNum(value);
      case "hours":
        return t("payments.hours", { n: value });
      default:
        return fmtNum(value);
    }
  }

  return (
    <Panel>
      <PanelHead title={t("payments.structure")}>
        {editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setDraft(defaultsDraft())} disabled={busy}>
              <RotateCcwIcon data-icon="inline-start" />
              {t("payments.reset")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={start}>
            <PencilIcon data-icon="inline-start" />
            {t("payments.edit")}
          </Button>
        )}
      </PanelHead>
      <dl className="flex flex-col gap-2 border-t px-4 py-3">
        {FIELDS.map((field) => (
          <div key={field.key} className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <dt className="text-sm">{t(field.label)}</dt>
              <dd className="text-xs text-muted-foreground">{t(field.hint)}</dd>
            </div>
            {editing ? (
              <Input
                value={draft[field.key]}
                inputMode="decimal"
                onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                className="h-8 w-28 text-right tabular-nums"
                aria-label={t(field.label)}
              />
            ) : (
              <span className="shrink-0 text-sm font-medium tabular-nums">{shown(field)}</span>
            )}
          </div>
        ))}
      </dl>
    </Panel>
  );
}

"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";

// Ссылка только для чтения и кнопка «Скопировать».
export function CopyField({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copy.failed"));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={value}
        aria-label={label ?? t("copy.linkAria")}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={copy}
        title={t("copy.button")}
        aria-label={t("copy.button")}
      >
        {copied ? <CheckIcon className="text-emerald-600" /> : <CopyIcon />}
      </Button>
    </div>
  );
}

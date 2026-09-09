"use client";

import { useState } from "react";
import { LinkIcon } from "lucide-react";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInvite } from "@/lib/api/invites";
import { useT } from "@/lib/i18n";
import { useProfile } from "@/lib/profile-context";
import { fmtDate } from "@/lib/format";

// Ссылку выпускает сам админ: вставка в `invites`, токен и срок ставит база.
// Письма не шлём (почта Supabase на бесплатном тарифе ограничена) — админ отправляет сам.
export function InviteDialog({ onCreated }: { onCreated: () => void }) {
  const profile = useProfile();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; expires_at: string } | null>(null);

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v) {
      setNote("");
      setError(null);
      setResult(null);
    }
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createInvite(note, profile.user_id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult({ url: res.data.url, expires_at: res.data.expires_at });
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <LinkIcon data-icon="inline-start" />
          {t("invites.button")}
        </Button>
      </DialogTrigger>
      {/* На низком экране кнопки не должны уезжать за край: не выше экрана, внутри прокрутка. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("invites.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("invites.dialogDescription")}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col gap-2">
            <CopyField value={result.url} label={t("invites.linkLabel")} />
            <p className="text-xs text-muted-foreground">
              {t("invites.validUntil", { date: fmtDate(result.expires_at) })}
            </p>
          </div>
        ) : (
          <form onSubmit={generate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-note">{t("invites.noteLabel")}</Label>
              <Input
                id="invite-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("invites.notePlaceholder")}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">{t("invites.noteHint")}</p>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("invites.submitting") : t("invites.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

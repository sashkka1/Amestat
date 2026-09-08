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
import { useProfile } from "@/lib/profile-context";
import { fmtDate } from "@/lib/format";

// Ссылку выпускает сам админ: вставка в `invites`, токен и срок ставит база.
// Письма не шлём (почта Supabase на бесплатном тарифе ограничена) — админ отправляет сам.
export function InviteDialog({ onCreated }: { onCreated: () => void }) {
  const profile = useProfile();
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
          Сгенерировать ссылку регистрации
        </Button>
      </DialogTrigger>
      {/* На низком экране кнопки не должны уезжать за край: не выше экрана, внутри прокрутка. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ссылка регистрации менеджера</DialogTitle>
          <DialogDescription>
            Ссылка одноразовая: по ней менеджер сам задаст логин и пароль. Отправьте её как удобно —
            писем сайт не шлёт.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col gap-2">
            <CopyField value={result.url} label="Ссылка регистрации" />
            <p className="text-xs text-muted-foreground">
              Действует до {fmtDate(result.expires_at)}. Больше эта ссылка нигде не покажется целиком —
              скопируйте сейчас.
            </p>
          </div>
        ) : (
          <form onSubmit={generate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-note">Заметка (кому)</Label>
              <Input
                id="invite-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Например: Оля, менеджер по бьюти"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Необязательно — нужна только вам, чтобы понимать в журнале, кому ссылка ушла.
              </p>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Готовим…" : "Сгенерировать"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

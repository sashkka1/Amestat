"use client";

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { createCreator, setCreatorAvatar } from "@/lib/api/creators";
import { requestSync } from "@/lib/api/sync";
import { uploadAvatar } from "@/lib/avatar-upload";
import { parseHandle } from "@/lib/handle";

export function AddCreatorDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allOurs, setAllOurs] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseHandle(raw);

  function reset() {
    setRaw("");
    setName("");
    setDescription("");
    setAllOurs(true);
    setFile(null);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!parsed) {
      setError("Не понял ссылку или имя. Нужно: https://www.tiktok.com/@name, @name или name");
      return;
    }
    setBusy(true);
    try {
      const created = await createCreator({ raw, name, description, allVideosOurs: allOurs });
      if (!created.ok) {
        setError(created.error);
        return;
      }
      const id = created.data.id;

      if (file) {
        const up = await uploadAvatar(id, file);
        if ("error" in up) {
          toast.error(up.error);
        } else {
          const set = await setCreatorAvatar(id, up.url);
          if (!set.ok) toast.error(set.error);
        }
      }

      const sync = await requestSync(id);
      if (sync.ok) {
        toast.success(`@${created.data.handle} добавлен — данные появятся после обхода`);
      } else {
        toast.success(`@${created.data.handle} добавлен`);
        toast.error(sync.error);
      }
      setOpen(false);
      reset();
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon data-icon="inline-start" />
          Добавить креатора
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Новый креатор</DialogTitle>
            <DialogDescription>
              Ссылка на профиль TikTok или имя. Статистика появится после ближайшего обхода.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="raw">Ссылка или @имя</Label>
            <Input
              id="raw"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="https://www.tiktok.com/@name или @name"
              autoFocus
              required
            />
            {raw.trim() && (
              <p className="text-xs text-muted-foreground">
                {parsed ? `Будет @${parsed.handle} · ${parsed.profileUrl}` : "Не похоже на имя TikTok"}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Имя</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={parsed ? parsed.handle : "как в списке"}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Описание</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="all-ours"
              checked={allOurs}
              onCheckedChange={(v) => setAllOurs(v === true)}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="all-ours" className="cursor-pointer">
                Все видео этого креатора — наши
              </Label>
              <p className="text-xs text-muted-foreground">
                Без галочки новые видео в статистику не идут, пока не отметить их «наше» в таблице.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="avatar">Картинка</Label>
            <Input
              id="avatar"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              Необязательно: без неё аватар подтянет сборщик из TikTok.
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
            <Button type="submit" disabled={busy || !parsed}>
              {busy ? "Добавляем…" : "Добавить"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

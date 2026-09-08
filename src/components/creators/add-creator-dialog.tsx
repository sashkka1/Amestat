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
import { PlatformIcon } from "@/components/platform";
import { createCreator, setCreatorAvatar } from "@/lib/api/creators";
import { uploadAvatar } from "@/lib/avatar-upload";
import { parseHandle } from "@/lib/handle";
import type { Platform } from "@/lib/types";

const PLATFORMS: { key: Platform; label: string; placeholder: string }[] = [
  { key: "tiktok", label: "TikTok", placeholder: "https://www.tiktok.com/@name или @name" },
  { key: "instagram", label: "Instagram", placeholder: "https://www.instagram.com/name/ или name" },
];

const PARSE_ERROR =
  "Не понял ссылку или имя. Нужно: https://www.tiktok.com/@name, https://www.instagram.com/name/, @name или name";

export function AddCreatorDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allOurs, setAllOurs] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Голое имя разбирается по выбранной площадке; ссылка с доменом решает сама.
  const parsed = parseHandle(raw, platform);

  function onRawChange(value: string) {
    setRaw(value);
    const byLink = parseHandle(value, platform);
    if (byLink && byLink.platform !== platform) setPlatform(byLink.platform);
  }

  function reset() {
    setPlatform("tiktok");
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
      setError(PARSE_ERROR);
      return;
    }
    setBusy(true);
    try {
      const created = await createCreator({
        raw,
        platform,
        name,
        description,
        allVideosOurs: allOurs,
      });
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

      // Сборщика отсюда не зовём: данные придут с ближайшим обходом или по кнопке «Обновить».
      toast.success(`@${created.data.handle} добавлен — данные появятся после ближайшего обхода`);
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
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          Добавить вручную
        </Button>
      </DialogTrigger>
      {/* Семь полей не влезают в низкое окно: диалог не выше экрана, внутри прокрутка. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Новый креатор</DialogTitle>
            <DialogDescription>
              Ссылка на профиль TikTok или Instagram — или имя. Статистика появится после
              ближайшего обхода.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label>Площадка</Label>
            <div className="flex gap-1.5">
              {PLATFORMS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={platform === p.key ? "secondary" : "outline"}
                  aria-pressed={platform === p.key}
                  onClick={() => setPlatform(p.key)}
                >
                  <PlatformIcon platform={p.key} />
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="raw">Ссылка или @имя</Label>
            <Input
              id="raw"
              value={raw}
              onChange={(e) => onRawChange(e.target.value)}
              placeholder={PLATFORMS.find((p) => p.key === platform)?.placeholder}
              autoFocus
              required
            />
            {raw.trim() && (
              <p className="text-xs text-muted-foreground">
                {parsed
                  ? `Будет @${parsed.handle} · ${parsed.profileUrl}`
                  : "Не похоже на имя TikTok или Instagram"}
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
              Необязательно: без неё аватар подтянет сборщик с площадки.
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

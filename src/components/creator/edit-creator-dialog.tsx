"use client";

import { useState } from "react";
import { PencilIcon } from "lucide-react";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { setCreatorAvatar, updateCreator } from "@/lib/api/creators";
import { uploadAvatar } from "@/lib/avatar-upload";
import type { Creator } from "@/lib/types";

// Имя, описание и своя картинка. Галочка «все видео наши» и удаление живут в шапке.
export function EditCreatorDialog({
  creator,
  onSaved,
}: {
  creator: Creator;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(creator.display_name);
  const [description, setDescription] = useState(creator.description);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v) {
      setName(creator.display_name);
      setDescription(creator.description);
      setFile(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await updateCreator(creator.id, {
        display_name: name.trim() || creator.handle,
        description,
        all_videos_ours: creator.all_videos_ours,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (file) {
        const up = await uploadAvatar(creator.id, file);
        if ("error" in up) {
          toast.error(up.error);
        } else {
          const set = await setCreatorAvatar(creator.id, up.url);
          if (!set.ok) toast.error(set.error);
        }
      }
      toast.success("Сохранено");
      setOpen(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Редактировать" aria-label="Редактировать">
          <PencilIcon />
        </Button>
      </DialogTrigger>
      {/* На низком экране кнопки не должны уезжать за край: не выше экрана, внутри прокрутка. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Креатор @{creator.handle}</DialogTitle>
            <DialogDescription>Имя, описание и своя картинка.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-name">Имя</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-description">Описание</Label>
            <Textarea
              id="edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-avatar">Заменить картинку</Label>
            <Input
              id="edit-avatar"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {creator.avatar_custom && (
              <p className="text-xs text-muted-foreground">Сейчас стоит своя картинка.</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

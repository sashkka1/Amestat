"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { deleteCreator, setCreatorAvatar, updateCreator } from "@/lib/api/creators";
import { markCreatorVideosOurs } from "@/lib/api/videos";
import { uploadAvatar } from "@/lib/avatar-upload";
import type { Creator } from "@/lib/types";

export function EditCreatorDialog({
  creator,
  onSaved,
}: {
  creator: Creator;
  // Сохранили — страница перечитывает креатора.
  onSaved: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(creator.display_name);
  const [description, setDescription] = useState(creator.description);
  const [allOurs, setAllOurs] = useState(creator.all_videos_ours);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v) {
      setName(creator.display_name);
      setDescription(creator.description);
      setAllOurs(creator.all_videos_ours);
      setFile(null);
      setConfirmDelete(false);
    }
  }

  // Галочку включили (была выключена) — все уже собранные видео станут нашими.
  const turnsOn = allOurs && !creator.all_videos_ours;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await updateCreator(creator.id, {
        display_name: name.trim() || creator.handle,
        description,
        all_videos_ours: allOurs,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (turnsOn) {
        const marked = await markCreatorVideosOurs(creator.id);
        if (!marked.ok) toast.error(marked.error);
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

  async function remove() {
    setBusy(true);
    const res = await deleteCreator(creator.id);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`@${creator.handle} удалён`);
    router.replace("/");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Редактировать" aria-label="Редактировать">
          <PencilIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
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

          <div className="flex items-start gap-2">
            <Checkbox
              id="edit-all-ours"
              checked={allOurs}
              onCheckedChange={(v) => setAllOurs(v === true)}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="edit-all-ours" className="cursor-pointer">
                Все видео этого креатора — наши
              </Label>
              <p className="text-xs text-muted-foreground">
                {turnsOn
                  ? "При сохранении все уже собранные видео станут нашими."
                  : allOurs
                    ? "Новые видео считаются в статистике сразу."
                    : "Новые видео в статистику не идут, пока не отметить их «наше»; уже отмеченные не трогаем."}
              </p>
            </div>
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

        <Separator />

        {confirmDelete ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Удалить @{creator.handle} со всеми снимками и видео? Это необратимо.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                Нет
              </Button>
              <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
                {busy ? "Удаляем…" : "Да, удалить"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            className="self-start"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            Удалить креатора
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

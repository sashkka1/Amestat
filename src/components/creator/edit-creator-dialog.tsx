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
import { useT } from "@/lib/i18n";
import type { Creator } from "@/lib/types";

// Имя, описание и своя картинка. Галочка «все видео наши» и удаление живут в шапке.
export function EditCreatorDialog({
  creator,
  onSaved,
}: {
  creator: Creator;
  onSaved: () => void;
}) {
  const t = useT();
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
      toast.success(t("common.saved"));
      setOpen(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("editCreator.button")}
          aria-label={t("editCreator.button")}
        >
          <PencilIcon />
        </Button>
      </DialogTrigger>
      {/* На низком экране кнопки не должны уезжать за край: не выше экрана, внутри прокрутка. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("editCreator.title", { handle: creator.handle })}</DialogTitle>
            <DialogDescription>{t("editCreator.description")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-name">{t("editCreator.name")}</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-description">{t("editCreator.descriptionField")}</Label>
            <Textarea
              id="edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-avatar">{t("editCreator.avatar")}</Label>
            <Input
              id="edit-avatar"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {creator.avatar_custom && (
              <p className="text-xs text-muted-foreground">{t("editCreator.customAvatar")}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

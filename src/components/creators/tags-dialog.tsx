"use client";

import { useState, useTransition } from "react";
import { CheckIcon, PencilIcon, TagsIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TagPill } from "@/components/tag-pill";
import { createTag, deleteTag, updateTag } from "@/lib/api/tags";
import { useT } from "@/lib/i18n";
import { useProfile } from "@/lib/profile-context";
import type { Tag } from "@/lib/types";

const DEFAULT_COLOR = "#6B7280";

// Теги у каждого свои (v2): создаём их на вошедшего, чужих он и не увидит.
export function TagsDialog({ tags, onChanged }: { tags: Tag[]; onChanged: () => void }) {
  const profile = useProfile();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(DEFAULT_COLOR);
  const [pending, startTransition] = useTransition();

  function create(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await createTag(newName, newColor, profile.user_id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setNewName("");
      onChanged();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <TagsIcon data-icon="inline-start" />
          {t("tags.button")}
        </Button>
      </DialogTrigger>
      {/* Список тегов растёт: диалог не выше экрана, внутри прокрутка. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tags.title")}</DialogTitle>
          <DialogDescription>{t("tags.description")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={create} className="flex items-center gap-2">
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
            aria-label={t("tags.newColorAria")}
          />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("tags.newNamePlaceholder")}
            aria-label={t("tags.newNameAria")}
          />
          <Button type="submit" disabled={pending || !newName.trim()}>
            {t("common.create")}
          </Button>
        </form>

        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("tags.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {tags.map((t) => (
              <TagRow key={t.id} tag={t} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TagRow({ tag, onChanged }: { tag: Tag; onChanged: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await updateTag(tag.id, { name, color });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setEditing(false);
      onChanged();
    });
  }

  function recolor(c: string) {
    setColor(c);
    startTransition(async () => {
      const res = await updateTag(tag.id, { color: c });
      if (!res.ok) toast.error(res.error);
      else onChanged();
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteTag(tag.id);
      if (!res.ok) toast.error(res.error);
      else onChanged();
    });
  }

  return (
    <li className="flex items-center gap-2 py-2">
      <input
        type="color"
        value={color}
        onChange={(e) => (editing ? setColor(e.target.value) : recolor(e.target.value))}
        className="size-7 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
        aria-label={t("tags.colorAria", { name: tag.name })}
      />
      {editing ? (
        <>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <Button size="icon-sm" variant="ghost" onClick={save} disabled={pending} title={t("common.save")}>
            <CheckIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setName(tag.name);
              setColor(tag.color);
            }}
            title={t("common.cancel")}
          >
            <XIcon />
          </Button>
        </>
      ) : confirmDelete ? (
        <>
          <span className="flex-1 text-sm">{t("tags.confirmDelete", { name: tag.name })}</span>
          <Button size="sm" variant="destructive" onClick={remove} disabled={pending}>
            {t("common.delete")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t("common.no")}
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1">
            <TagPill name={tag.name} color={color} />
          </span>
          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title={t("common.rename")}>
            <PencilIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            title={t("common.delete")}
            className="text-destructive"
          >
            <Trash2Icon />
          </Button>
        </>
      )}
    </li>
  );
}

"use client";

import { useState, useTransition } from "react";
import { TagIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TagPill } from "@/components/tag-pill";
import { setCreatorTag } from "@/lib/api/creators";
import type { Tag } from "@/lib/types";

// Поповер с галочками: какие теги висят на креаторе.
export function TagPicker({
  creatorId,
  tags,
  selected,
  onChange,
}: {
  creatorId: string;
  tags: Tag[];
  selected: Set<string>;
  onChange?: (tagId: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  function toggle(tagId: string, on: boolean) {
    onChange?.(tagId, on);
    startTransition(async () => {
      const res = await setCreatorTag(creatorId, tagId, on);
      if (!res.ok) {
        toast.error(res.error);
        onChange?.(tagId, !on);
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Теги" aria-label="Теги">
          <TagIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        {tags.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">Тегов пока нет — заведите их кнопкой «Теги».</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tags.map((t) => {
              const id = `tag-${creatorId}-${t.id}`;
              const on = selected.has(t.id);
              return (
                <li key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                  <Checkbox
                    id={id}
                    checked={on}
                    onCheckedChange={(v) => toggle(t.id, v === true)}
                  />
                  <label htmlFor={id} className="flex flex-1 cursor-pointer items-center">
                    <TagPill name={t.name} color={t.color} size="xs" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

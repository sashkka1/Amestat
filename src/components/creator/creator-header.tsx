"use client";

import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { TagPill } from "@/components/tag-pill";
import { LocalTime } from "@/components/local-time";
import { TagPicker } from "@/components/creators/tag-picker";
import { EditCreatorDialog } from "./edit-creator-dialog";
import type { Creator, Tag } from "@/lib/types";

export function CreatorHeader({
  creator,
  tags,
  allTags,
  onChanged,
}: {
  creator: Creator;
  tags: Tag[];
  allTags: Tag[];
  // Креатора отредактировали — страница перечитывает данные.
  onChanged: () => void;
}) {
  const name = creator.display_name || creator.handle;

  // Галочки в поповере меняем сразу; свежие теги придут при следующем перечитывании.
  const [prevTags, setPrevTags] = useState(tags);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(tags.map((t) => t.id)));
  if (prevTags !== tags) {
    setPrevTags(tags);
    setSelected(new Set(tags.map((t) => t.id)));
  }
  const shownTags = allTags.filter((t) => selected.has(t.id));

  return (
    <section className="flex gap-4 rounded-xl border bg-card p-4 shadow-sm">
      <Avatar src={creator.avatar_url} name={name} size={80} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
            <a
              href={creator.profile_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              @{creator.handle}
              <ExternalLinkIcon className="size-3" />
            </a>
          </div>
          <div className="flex items-center gap-1">
            <TagPicker
              creatorId={creator.id}
              tags={allTags}
              selected={selected}
              onChange={(tagId, on) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(tagId);
                  else next.delete(tagId);
                  return next;
                })
              }
            />
            <EditCreatorDialog creator={creator} onSaved={onChanged} />
          </div>
        </div>
        {creator.description && (
          <p className="whitespace-pre-line text-sm text-muted-foreground">{creator.description}</p>
        )}
        {shownTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {shownTags.map((t) => (
              <TagPill key={t.id} name={t.name} color={t.color} size="xs" />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>
            добавлен: <LocalTime iso={creator.added_at} mode="date" />
          </span>
          <span>
            обход: <LocalTime iso={creator.last_synced_at} />
          </span>
          {!creator.all_videos_ours && (
            <span title="Новые видео в статистику не идут, пока их не отметить «наше» в таблице">
              не все видео наши
            </span>
          )}
        </div>
        {creator.sync_error && <p className="text-xs text-destructive">{creator.sync_error}</p>}
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ExternalLinkIcon, GripVerticalIcon, UsersIcon } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { TagPill } from "@/components/tag-pill";
import { LocalTime } from "@/components/local-time";
import { TagPicker } from "./tag-picker";
import { fmtNum } from "@/lib/format";
import type { Creator, CreatorLatest, Tag } from "@/lib/types";
import { cn } from "@/lib/utils";

export type CardProps = {
  creator: Creator;
  tags: Tag[];
  allTags: Tag[];
  latest: CreatorLatest | undefined;
  draggable: boolean;
  onTagChange: (creatorId: string, tagId: string, on: boolean) => void;
};

export function CreatorCard(props: CardProps) {
  const { creator, tags, allTags, latest, draggable, onTagChange } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: creator.id, disabled: !draggable });

  const name = creator.display_name || creator.handle;
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex gap-3 rounded-xl border bg-card p-3 shadow-sm",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      {draggable && (
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          type="button"
          className="-ml-1 flex cursor-grab touch-none items-center text-muted-foreground active:cursor-grabbing"
          aria-label="Перетащить"
          title="Перетащить"
        >
          <GripVerticalIcon className="size-4" />
        </button>
      )}

      <Link href={`/creator/?id=${creator.id}`} className="shrink-0" tabIndex={-1}>
        <Avatar src={creator.avatar_url} name={name} size={56} />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/creator/?id=${creator.id}`}
              className="block truncate font-medium hover:underline"
            >
              {name}
            </Link>
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
          <TagPicker
            creatorId={creator.id}
            tags={allTags}
            selected={new Set(tags.map((t) => t.id))}
            onChange={(tagId, on) => onTagChange(creator.id, tagId, on)}
          />
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <TagPill key={t.id} name={t.name} color={t.color} size="xs" />
            ))}
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1" title="Подписчики">
            <UsersIcon className="size-3.5" />
            {fmtNum(latest?.followers)}
          </span>
          <span title="Последний удачный обход">
            обход: <LocalTime iso={creator.last_synced_at} />
          </span>
        </div>
        {!creator.all_videos_ours && (
          <p className="text-xs text-muted-foreground" title="Новые видео этого креатора в статистику не идут, пока их не отметить «наше»">
            не все видео наши
          </p>
        )}
        {creator.sync_error && (
          <p className="truncate text-xs text-destructive" title={creator.sync_error}>
            {creator.sync_error}
          </p>
        )}
      </div>
    </div>
  );
}

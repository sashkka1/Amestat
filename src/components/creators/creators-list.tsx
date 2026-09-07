"use client";

import { useMemo, useState, useTransition } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { ArrowDownAZIcon, ArrowUpAZIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagPill } from "@/components/tag-pill";
import { CreatorCard } from "./creator-card";
import { AddCreatorDialog } from "./add-creator-dialog";
import { TagsDialog } from "./tags-dialog";
import { saveOrder } from "@/lib/api/creators";
import type { Creator, CreatorLatest, CreatorTag, Tag } from "@/lib/types";
import { cn } from "@/lib/utils";

type SortMode = "added_desc" | "added_asc" | "custom";

export function CreatorsList({
  creators,
  tags,
  creatorTags,
  latest,
  onChanged,
}: {
  creators: Creator[];
  tags: Tag[];
  creatorTags: CreatorTag[];
  latest: CreatorLatest[];
  // Что-то записали в базу — страница перечитывает данные.
  onChanged: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<SortMode>("added_desc");
  const [customOrder, setCustomOrder] = useState<string[]>(() => creators.map((c) => c.id));
  const [localTags, setLocalTags] = useState<CreatorTag[]>(creatorTags);
  const [, startTransition] = useTransition();

  // Страница перечитала данные (onChanged) — подхватываем порядок и теги.
  // Сравнение прежних пропсов прямо в рендере — приём из документации React.
  const [prevCreators, setPrevCreators] = useState(creators);
  if (prevCreators !== creators) {
    setPrevCreators(creators);
    setCustomOrder(creators.map((c) => c.id));
  }
  const [prevCreatorTags, setPrevCreatorTags] = useState(creatorTags);
  if (prevCreatorTags !== creatorTags) {
    setPrevCreatorTags(creatorTags);
    setLocalTags(creatorTags);
  }

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const latestById = useMemo(() => new Map(latest.map((l) => [l.creator_id, l])), [latest]);
  const tagsByCreator = useMemo(() => {
    const m = new Map<string, Tag[]>();
    for (const ct of localTags) {
      const t = tagById.get(ct.tag_id);
      if (!t) continue;
      const arr = m.get(ct.creator_id) ?? [];
      arr.push(t);
      m.set(ct.creator_id, arr);
    }
    return m;
  }, [localTags, tagById]);

  const filterActive = search.trim() !== "" || selectedTags.size > 0;

  const visible = useMemo(() => {
    const byId = new Map(creators.map((c) => [c.id, c]));
    let list: Creator[];
    if (sortMode === "custom") {
      list = customOrder.map((id) => byId.get(id)).filter((c): c is Creator => Boolean(c));
    } else {
      list = [...creators].sort((a, b) => {
        const d = new Date(a.added_at).getTime() - new Date(b.added_at).getTime();
        return sortMode === "added_asc" ? d : -d;
      });
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) => c.display_name.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q),
      );
    }
    if (selectedTags.size > 0) {
      list = list.filter((c) => {
        const own = new Set((tagsByCreator.get(c.id) ?? []).map((t) => t.id));
        for (const id of selectedTags) if (!own.has(id)) return false;
        return true;
      });
    }
    return list;
  }, [creators, sortMode, customOrder, search, selectedTags, tagsByCreator]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = customOrder.indexOf(String(active.id));
    const to = customOrder.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(customOrder, from, to);
    setCustomOrder(next);
    startTransition(async () => {
      const res = await saveOrder(next);
      if (!res.ok) toast.error(res.error);
    });
  }

  function onTagChange(creatorId: string, tagId: string, on: boolean) {
    setLocalTags((prev) => {
      const without = prev.filter((ct) => !(ct.creator_id === creatorId && ct.tag_id === tagId));
      return on ? [...without, { creator_id: creatorId, tag_id: tagId }] : without;
    });
  }

  function toggleFilterTag(id: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const draggable = sortMode === "custom" && !filterActive;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по имени или @имени"
              className="pl-8"
              aria-label="Поиск"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border p-0.5">
            <Button
              size="sm"
              variant={sortMode !== "custom" ? "secondary" : "ghost"}
              onClick={() =>
                setSortMode((m) =>
                  m === "added_desc" ? "added_asc" : m === "added_asc" ? "added_desc" : "added_desc",
                )
              }
              title="По дате добавления (нажать ещё раз — сменить направление)"
            >
              {sortMode === "added_asc" ? <ArrowUpAZIcon data-icon="inline-start" /> : <ArrowDownAZIcon data-icon="inline-start" />}
              По дате добавления
            </Button>
            <Button
              size="sm"
              variant={sortMode === "custom" ? "secondary" : "ghost"}
              onClick={() => setSortMode("custom")}
            >
              Свой порядок
            </Button>
          </div>
          <TagsDialog tags={tags} onChanged={onChanged} />
          <AddCreatorDialog onAdded={onChanged} />
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((t) => (
              <TagPill
                key={t.id}
                name={t.name}
                color={t.color}
                active={selectedTags.has(t.id)}
                onClick={() => toggleFilterTag(t.id)}
              />
            ))}
            {selectedTags.size > 0 && (
              <Button variant="ghost" size="xs" onClick={() => setSelectedTags(new Set())}>
                Сбросить
              </Button>
            )}
          </div>
        )}

        {sortMode === "custom" && filterActive && (
          <p className="text-xs text-muted-foreground">
            Перетаскивание работает без поиска и фильтра по тегам.
          </p>
        )}
      </div>

      {creators.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Пока никого нет — нажмите «Добавить креатора».
        </p>
      ) : visible.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Никто не подходит под фильтр.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((c) => c.id)} strategy={rectSortingStrategy}>
            <div className={cn("grid gap-3", "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")}>
              {visible.map((c) => (
                <CreatorCard
                  key={c.id}
                  creator={c}
                  tags={tagsByCreator.get(c.id) ?? []}
                  allTags={tags}
                  latest={latestById.get(c.id)}
                  draggable={draggable}
                  onTagChange={onTagChange}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

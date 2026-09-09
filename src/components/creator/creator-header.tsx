"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { PlatformChip } from "@/components/platform";
import { TagPill } from "@/components/tag-pill";
import { LocalTime } from "@/components/local-time";
import { TagPicker } from "@/components/creators/tag-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EditCreatorDialog } from "./edit-creator-dialog";
import { deleteCreator, updateCreator } from "@/lib/api/creators";
import { assignManager, unassignManager } from "@/lib/api/managers";
import { markCreatorVideosOurs } from "@/lib/api/videos";
import { profileName } from "@/lib/api/profiles";
import { useT } from "@/lib/i18n";
import { useProfile } from "@/lib/profile-context";
import type { Creator, Profile, Tag } from "@/lib/types";

export function CreatorHeader({
  creator,
  tags,
  allTags,
  managers,
  assigned,
  onChanged,
}: {
  creator: Creator;
  tags: Tag[];
  allTags: Tag[];
  // Все менеджеры — только у админа; менеджеру RLS отдаст лишь его собственную строку.
  managers: Profile[];
  assigned: Set<string>;
  onChanged: () => void;
}) {
  const router = useRouter();
  const profile = useProfile();
  const t = useT();
  const isAdmin = profile.role === "admin";
  const name = creator.display_name || creator.handle;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [allOurs, setAllOurs] = useState(creator.all_videos_ours);
  const [, startTransition] = useTransition();

  // Галочки тегов меняем сразу; свежие теги придут при следующем перечитывании.
  const [prevTags, setPrevTags] = useState(tags);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(tags.map((t) => t.id)));
  if (prevTags !== tags) {
    setPrevTags(tags);
    setSelected(new Set(tags.map((t) => t.id)));
  }
  const shownTags = allTags.filter((t) => selected.has(t.id));

  // Включили галочку — все уже собранные видео креатора становятся нашими.
  function toggleAllOurs(on: boolean) {
    setAllOurs(on);
    startTransition(async () => {
      const res = await updateCreator(creator.id, {
        display_name: creator.display_name,
        description: creator.description,
        all_videos_ours: on,
      });
      if (!res.ok) {
        toast.error(res.error);
        setAllOurs(!on);
        return;
      }
      if (on) {
        const marked = await markCreatorVideosOurs(creator.id);
        if (!marked.ok) toast.error(marked.error);
      }
      onChanged();
    });
  }

  async function remove() {
    setBusy(true);
    const res = await deleteCreator(creator.id);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("creator.deleted", { handle: creator.handle }));
    router.replace("/creators/");
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex gap-4">
        <Avatar src={creator.avatar_url} name={name} size={72} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            {/* Только хэндл (владелец, 2026-09-09): имя креатора не показываем нигде на
                странице — оно остаётся в диалоге правки и в заголовке вкладки. */}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={creator.profile_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-lg font-semibold tracking-tight hover:text-muted-foreground"
                >
                  @{creator.handle}
                  <ExternalLinkIcon className="size-3.5" />
                </a>
                <PlatformChip platform={creator.platform} />
              </div>
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
              {isAdmin && (
                <ManagersPopover creator={creator} managers={managers} assigned={assigned} onChanged={onChanged} />
              )}
              <EditCreatorDialog creator={creator} onSaved={onChanged} />
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("creator.deleteTitle")}
                aria-label={t("creator.deleteTitle")}
                className="text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon />
              </Button>
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

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("creator.added")} <LocalTime iso={creator.added_at} mode="date" />
            </span>
            <span>
              {t("creator.updated")} <LocalTime iso={creator.last_synced_at} mode="date" />
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <Checkbox checked={allOurs} onCheckedChange={(v) => toggleAllOurs(v === true)} />
              {t("creator.allOurs")}
            </label>
          </div>
          {creator.needs_reconnect && (
            <p className="text-xs text-destructive">{t("creator.needsReconnect")}</p>
          )}
          {creator.sync_error && <p className="text-xs text-destructive">{creator.sync_error}</p>}
        </div>
      </div>

      {confirmDelete && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm">{t("creator.confirmDelete", { handle: creator.handle })}</p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
              {t("common.no")}
            </Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
              {busy ? t("common.deleting") : t("common.yesDelete")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// Кому виден креатор. Связь пишет только админ (RLS).
function ManagersPopover({
  creator,
  managers,
  assigned,
  onChanged,
}: {
  creator: Creator;
  managers: Profile[];
  assigned: Set<string>;
  onChanged: () => void;
}) {
  const t = useT();
  const [local, setLocal] = useState(assigned);
  const [prev, setPrev] = useState(assigned);
  if (prev !== assigned) {
    setPrev(assigned);
    setLocal(assigned);
  }

  function toggle(managerId: string, on: boolean) {
    setLocal((p) => {
      const next = new Set(p);
      if (on) next.add(managerId);
      else next.delete(managerId);
      return next;
    });
    void (async () => {
      const res = on
        ? await assignManager(creator.id, managerId)
        : await unassignManager(creator.id, managerId);
      if (!res.ok) {
        toast.error(res.error);
        setLocal((p) => {
          const next = new Set(p);
          if (on) next.delete(managerId);
          else next.add(managerId);
          return next;
        });
        return;
      }
      onChanged();
    })();
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("creator.managersButton")}
          aria-label={t("creator.managersButton")}
        >
          <UsersIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <p className="px-2 pb-1 text-xs text-muted-foreground">{t("creator.whoSees")}</p>
        {managers.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">{t("creator.managersEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {managers.map((m) => {
              const id = `mgr-${creator.id}-${m.user_id}`;
              return (
                <li key={m.user_id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                  <Checkbox
                    id={id}
                    checked={local.has(m.user_id)}
                    onCheckedChange={(v) => toggle(m.user_id, v === true)}
                  />
                  <label htmlFor={id} className="flex-1 cursor-pointer truncate text-sm">
                    {profileName(m)}
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

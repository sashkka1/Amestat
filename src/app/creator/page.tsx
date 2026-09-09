"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { PeriodChip } from "@/components/period-chip";
import { SyncButton } from "@/components/sync-button";
import { SyncLogPanel } from "@/components/sync-log-panel";
import { CreatorHeader } from "@/components/creator/creator-header";
import { CreatorStats } from "@/components/creator/creator-stats";
import { creatorById, listCreatorManagers, listCreatorTags, listTags } from "@/lib/queries";
import { listManagers } from "@/lib/api/profiles";
import { useLoader } from "@/lib/use-loader";
import { usePeriod } from "@/lib/use-period";
import type { Creator, Profile, Tag } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Data = {
  creator: Creator | null;
  allTags: Tag[];
  ownTags: Tag[];
  managers: Profile[];
  assigned: Set<string>;
};

async function loadCreator(id: string): Promise<Data> {
  const [creator, allTags, creatorTags, managers, links] = await Promise.all([
    creatorById(id),
    listTags(),
    listCreatorTags(),
    listManagers(),
    listCreatorManagers(),
  ]);
  const ownIds = new Set(creatorTags.filter((ct) => ct.creator_id === id).map((ct) => ct.tag_id));
  return {
    creator,
    allTags,
    ownTags: allTags.filter((t) => ownIds.has(t.id)),
    managers,
    assigned: new Set(links.filter((l) => l.creator_id === id).map((l) => l.manager_id)),
  };
}

// Статика не умеет /creators/[id], поэтому адрес — /creator/?id=<uuid>.
// useSearchParams требует Suspense при статической сборке.
export default function CreatorPage() {
  return (
    <AuthGate>
      <Suspense fallback={<Page title="Креатор"><PageSkeleton /></Page>}>
        <CreatorRoute />
      </Suspense>
    </AuthGate>
  );
}

function CreatorRoute() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (!UUID_RE.test(id)) {
    return (
      <Page title="Креатор">
        <p className="text-sm text-muted-foreground">В адресе нет id креатора.</p>
      </Page>
    );
  }
  return <CreatorView id={id} />;
}

function CreatorView({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoader(() => loadCreator(id), [id]);
  // Креатора отредактировали — перечитать и шапку, и статистику.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    reload();
    setVersion((v) => v + 1);
  }, [reload]);

  const creator = data?.creator ?? null;
  // Пока креатор не прочитан, «Всё время» отсчитывается от года назад. Момент берётся
  // один раз при монтировании: в теле рендера часов спрашивать нельзя.
  const [fallbackEarliest] = useState(() => new Date(Date.now() - 365 * 86_400_000));
  const earliest = useMemo(
    () => (creator ? new Date(creator.added_at) : fallbackEarliest),
    [creator, fallbackEarliest],
  );
  const period = usePeriod(earliest);
  const name = creator ? creator.display_name || creator.handle : "Креатор";
  // «Только эта страница» на карточке — это один креатор.
  const pageCreatorIds = useMemo(() => [id], [id]);

  return (
    <Page
      title={name}
      subtitle={creator ? `@${creator.handle}` : undefined}
      actions={
        <>
          <SyncButton scope={id} pageCreatorIds={pageCreatorIds} onDone={refresh} />
          <PeriodChip period={period} />
        </>
      }
    >
      {/* Ход обновления — только администратору. Обход берётся с учётом scope: тот, что
          касался этого креатора (его собственный или обход всех), как и время «Обновлено». */}
      <SyncLogPanel scope={id} />

      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton />
      ) : !creator ? (
        <p className="text-sm text-muted-foreground">Такого креатора нет — возможно, он удалён.</p>
      ) : data ? (
        <>
          <CreatorHeader
            creator={creator}
            tags={data.ownTags}
            allTags={data.allTags}
            managers={data.managers}
            assigned={data.assigned}
            onChanged={refresh}
          />
          <CreatorStats creator={creator} period={period} refreshKey={version} />
        </>
      ) : null}
    </Page>
  );
}

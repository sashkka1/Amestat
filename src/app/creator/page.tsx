"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { PeriodBar } from "@/components/stats/period-bar";
import { SyncButton } from "@/components/sync-button";
import { SyncLogPanel } from "@/components/sync-log-panel";
import { CreatorHeader } from "@/components/creator/creator-header";
import { CreatorStats } from "@/components/creator/creator-stats";
import { creatorById, listCreatorManagers, listCreatorTags, listTags } from "@/lib/queries";
import { listManagers } from "@/lib/api/profiles";
import { useCompare, useScope } from "@/lib/dashboard-prefs";
import { useT } from "@/lib/i18n";
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
  const t = useT();
  return (
    <AuthGate>
      <Suspense
        fallback={
          <Page title={t("creator.title")}>
            <PageSkeleton />
          </Page>
        }
      >
        <CreatorRoute />
      </Suspense>
    </AuthGate>
  );
}

function CreatorRoute() {
  const t = useT();
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  // `?video=` — какой ролик открыть сразу: с ним сюда ведут карточки «Лучших видео».
  const videoId = params.get("video");
  if (!UUID_RE.test(id)) {
    return (
      <Page title={t("creator.title")}>
        <p className="text-sm text-muted-foreground">{t("creator.noId")}</p>
      </Page>
    );
  }
  return <CreatorView id={id} videoId={videoId} />;
}

function CreatorView({ id, videoId }: { id: string; videoId: string | null }) {
  const t = useT();
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
  const name = creator ? creator.display_name || creator.handle : t("creator.title");
  // «Только эта страница» на карточке — это один креатор.
  const pageCreatorIds = useMemo(() => [id], [id]);

  // Те же две настройки, что на дашборде, и те же сторы: выбор общий на весь сайт
  // (`lib/dashboard-prefs.ts`). Сама статистика читает их своим хуком — стор один и тот же,
  // поэтому полоса и содержимое всегда согласованы.
  const compare = useCompare();
  const { scope, setScope } = useScope();

  return (
    <Page
      title={name}
      subtitle={creator ? `@${creator.handle}` : undefined}
      actions={<SyncButton scope={id} pageCreatorIds={pageCreatorIds} onDone={refresh} />}
    >
      {/* Полоса периода вместо прежней пилюли в шапке: чем ограничена страница по времени
          и по видео — в одном месте, как на дашборде. */}
      <PeriodBar
        period={period}
        compare={compare.on}
        onCompare={compare.set}
        scope={scope}
        onScope={setScope}
        scopeNote="periodBar.scopeServerNoteCreator"
      />

      {/* Ход обновления — только администратору. Обход берётся с учётом scope: тот, что
          касался этого креатора (его собственный или обход всех), как и время «Обновлено». */}
      <SyncLogPanel scope={id} />

      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton />
      ) : !creator ? (
        <p className="text-sm text-muted-foreground">{t("creator.notFound")}</p>
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
          <CreatorStats
            creator={creator}
            period={period}
            refreshKey={version}
            initialVideoId={videoId}
          />
        </>
      ) : null}
    </Page>
  );
}

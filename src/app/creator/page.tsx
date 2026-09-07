"use client";

import { Suspense, useCallback, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { AuthGate } from "@/components/auth-gate";
import { Header } from "@/components/header";
import { SyncControl } from "@/components/sync-control";
import { CreatorHeader } from "@/components/creator/creator-header";
import { CreatorStats } from "@/components/creator/creator-stats";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useLoader } from "@/lib/use-loader";
import type { Creator, Tag } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreatorData = { creator: Creator | null; allTags: Tag[]; ownTags: Tag[] };

async function loadCreator(id: string): Promise<CreatorData> {
  const supabase = createClient();
  const [creatorRes, tagsRes, ownTagsRes] = await Promise.all([
    supabase.from("creators").select("*").eq("id", id).maybeSingle(),
    supabase.from("tags").select("*").order("name"),
    supabase.from("creator_tags").select("tag_id").eq("creator_id", id),
  ]);
  const error = creatorRes.error ?? tagsRes.error ?? ownTagsRes.error;
  if (error) throw new Error(error.message);
  const allTags = tagsRes.data ?? [];
  const ownIds = new Set((ownTagsRes.data ?? []).map((r) => r.tag_id));
  return { creator: creatorRes.data, allTags, ownTags: allTags.filter((t) => ownIds.has(t.id)) };
}

// Статика не умеет /creators/[id], поэтому адрес — /creator/?id=<uuid>.
// useSearchParams требует Suspense при статической сборке.
export default function CreatorPage() {
  return (
    <AuthGate>
      <Suspense fallback={<PageSkeleton />}>
        <CreatorRoute />
      </Suspense>
    </AuthGate>
  );
}

function CreatorRoute() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (!UUID_RE.test(id)) return <Missing text="В адресе нет id креатора." />;
  return <CreatorView id={id} />;
}

function CreatorView({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoader(() => loadCreator(id), [id]);
  // Обход закончился или креатора отредактировали — перечитать и шапку, и статистику.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    reload();
    setVersion((v) => v + 1);
  }, [reload]);

  if (error) {
    return (
      <>
        <Header />
        <main className="mx-auto w-full max-w-6xl px-4 py-4">
          <p className="text-sm text-destructive">Не удалось прочитать базу: {error}</p>
        </main>
      </>
    );
  }
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  if (!data.creator) return <Missing text="Такого креатора нет — возможно, он удалён." />;
  const creator = data.creator;

  return (
    <>
      <Header>
        <BackLink />
        <SyncControl creatorId={creator.id} buttonLabel="Обновить этого" onSynced={refresh} compact />
      </Header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-4">
        <CreatorHeader creator={creator} tags={data.ownTags} allTags={data.allTags} onChanged={refresh} />
        <CreatorStats creator={creator} refreshKey={version} />
      </main>
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      <span className="hidden sm:inline">К списку</span>
    </Link>
  );
}

function Missing({ text }: { text: string }) {
  return (
    <>
      <Header>
        <BackLink />
      </Header>
      <main className="mx-auto w-full max-w-6xl px-4 py-10 text-center text-sm text-muted-foreground">
        {text}
      </main>
    </>
  );
}

function PageSkeleton() {
  return (
    <>
      <Header>
        <BackLink />
      </Header>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-4" aria-busy="true">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-8 w-80" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
      </main>
    </>
  );
}

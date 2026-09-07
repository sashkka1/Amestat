"use client";

import { AuthGate } from "@/components/auth-gate";
import { Header } from "@/components/header";
import { SyncControl } from "@/components/sync-control";
import { CreatorsList } from "@/components/creators/creators-list";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useLoader } from "@/lib/use-loader";
import type { Creator, CreatorLatest, CreatorTag, Tag } from "@/lib/types";

type HomeData = {
  creators: Creator[];
  tags: Tag[];
  creatorTags: CreatorTag[];
  latest: CreatorLatest[];
};

async function loadHome(): Promise<HomeData> {
  const supabase = createClient();
  const [creatorsRes, tagsRes, creatorTagsRes, latestRes] = await Promise.all([
    supabase
      .from("creators")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("added_at", { ascending: true }),
    supabase.from("tags").select("*").order("name"),
    supabase.from("creator_tags").select("*"),
    supabase.from("creator_latest").select("*"),
  ]);
  const error = creatorsRes.error ?? tagsRes.error ?? creatorTagsRes.error ?? latestRes.error;
  if (error) throw new Error(error.message);
  return {
    creators: creatorsRes.data ?? [],
    tags: tagsRes.data ?? [],
    creatorTags: creatorTagsRes.data ?? [],
    latest: latestRes.data ?? [],
  };
}

export default function HomePage() {
  return (
    <AuthGate>
      <Home />
    </AuthGate>
  );
}

function Home() {
  const { data, error, loading, reload } = useLoader(loadHome, []);

  return (
    <>
      <Header>
        <SyncControl creatorId={null} buttonLabel="Обновить всё" onSynced={reload} />
      </Header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4">
        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Не удалось прочитать базу: {error}
          </p>
        ) : loading && !data ? (
          <ListSkeleton />
        ) : data ? (
          <CreatorsList
            creators={data.creators}
            tags={data.tags}
            creatorTags={data.creatorTags}
            latest={data.latest}
            onChanged={reload}
          />
        ) : null}
      </main>
    </>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-8 w-full" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}

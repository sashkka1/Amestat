"use client";

import { useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Cover } from "@/components/cover";
import { PlatformIcon } from "@/components/platform";
import { Input } from "@/components/ui/input";
import { Panel, PanelHead, Empty } from "./panel";
import { fmtCompact, fmtDayAxis, fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

export type PostItem = {
  id: string;
  caption: string;
  coverUrl: string | null;
  url: string;
  publishedAt: string | null;
  views: number;
  creatorName: string;
  handle: string;
  platform: Platform;
};

type Sort = "views" | "new";

// «Лучшие видео»: полоса обложек с прокруткой вбок.
export function TopPosts({
  posts,
  title,
  limit = 10,
  showCreator = true,
  collapseKey,
}: {
  posts: PostItem[];
  title?: string;
  limit?: number;
  showCreator?: boolean;
  collapseKey?: string;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("views");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? posts.filter((p) => p.caption.toLowerCase().includes(q)) : posts;
    const sorted = [...filtered].sort((a, b) =>
      sort === "views"
        ? b.views - a.views
        : (b.publishedAt ? new Date(b.publishedAt).getTime() : 0) -
          (a.publishedAt ? new Date(a.publishedAt).getTime() : 0),
    );
    return sorted.slice(0, limit);
  }, [posts, search, sort, limit]);

  return (
    <Panel collapseKey={collapseKey}>
      <PanelHead title={title ?? t("topPosts.title")}>
        <div className="relative w-44">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("topPosts.searchPlaceholder")}
            className="h-8 pl-8 text-xs"
            aria-label={t("topPosts.searchPlaceholder")}
          />
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
          <SortButton active={sort === "views"} onClick={() => setSort("views")}>
            {t("topPosts.sortViews")}
          </SortButton>
          <SortButton active={sort === "new"} onClick={() => setSort("new")}>
            {t("topPosts.sortNew")}
          </SortButton>
        </div>
      </PanelHead>

      {shown.length === 0 ? (
        <Empty>{t("topPosts.empty")}</Empty>
      ) : (
        <ul className="flex gap-3 overflow-x-auto px-4 pb-4">
          {shown.map((p, i) => (
            <li key={p.id} className="w-[180px] shrink-0">
              <a href={p.url} target="_blank" rel="noopener noreferrer" className="group block">
                <div className="relative">
                  <Cover src={p.coverUrl} width={180} className="w-full" />
                  <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    #{i + 1}
                  </span>
                  <span
                    className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums"
                    title={fmtNum(p.views)}
                  >
                    {fmtCompact(p.views)}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs group-hover:underline" title={p.caption}>
                  {p.caption || t("common.noCaption")}
                </p>
              </a>
              <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <PlatformIcon platform={p.platform} className="size-3" />
                <span className="truncate">@{p.handle}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {p.publishedAt ? fmtDayAxis(p.publishedAt) : t("topPosts.noDate")}
                {showCreator && p.creatorName ? ` · ${p.creatorName}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

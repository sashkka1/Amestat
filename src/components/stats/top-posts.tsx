"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EyeIcon, MessageCircleIcon, SearchIcon } from "lucide-react";
import { Cover } from "@/components/cover";
import { PlatformIcon } from "@/components/platform";
import { Input } from "@/components/ui/input";
import { Panel, PanelHead, Empty } from "./panel";
import { CrossCounts, MentionMark } from "./cross-badge";
import { fmtCompact, fmtDayAxis, fmtNum } from "@/lib/format";
import { engagementRate } from "@/lib/stats";
import { useT, type TKey } from "@/lib/i18n";
import type { CrossInfo } from "@/lib/cross";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

export type PostItem = {
  id: string;
  // Чей это ролик: по щелчку карточка ведёт на карточку креатора с открытым видео.
  creatorId: string;
  caption: string;
  coverUrl: string | null;
  url: string;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  creatorName: string;
  handle: string;
  platform: Platform;
};

type Sort = "views" | "likes" | "comments" | "engagement";

const SORTS: { key: Sort; label: TKey }[] = [
  { key: "views", label: "topPosts.sortViews" },
  { key: "likes", label: "topPosts.sortLikes" },
  { key: "comments", label: "topPosts.sortComments" },
  { key: "engagement", label: "topPosts.sortEngagement" },
];

// Вовлечённость — доля от просмотров, как в таблице видео: без деления сравнивались бы
// не ролики, а их охваты.
function sortValue(p: PostItem, sort: Sort): number {
  switch (sort) {
    case "likes":
      return p.likes;
    case "comments":
      return p.comments;
    case "engagement":
      return engagementRate(p);
    default:
      return p.views;
  }
}

// «Лучшие видео»: полоса обложек с прокруткой вбок.
export function TopPosts({
  posts,
  title,
  limit = 10,
  showCreator = true,
  collapseKey,
  onSelect,
  cross,
}: {
  posts: PostItem[];
  title?: string;
  limit?: number;
  showCreator?: boolean;
  collapseKey?: string;
  // Перекрёстность по id видео (миграция v29): задана — под обложкой встают три числа
  // «снято · не авторских · от других наших». Не задана — карточка без строки комментариев.
  cross?: Map<string, CrossInfo>;
  // Задан — щелчок остаётся на странице и отдаёт видео хозяину (шторка дашборда). Не задан —
  // прежний переход на карточку креатора с открытым видео (карточка креатора, владелец
  // 2026-09-09: там поведение не меняется).
  onSelect?: (videoId: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("views");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? posts.filter((p) => p.caption.toLowerCase().includes(q)) : posts;
    const sorted = [...filtered].sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
    return sorted.slice(0, limit);
  }, [posts, search, sort, limit]);

  // Подсказка «прокрути» появляется, только когда лента и правда шире окна: ширина зависит
  // и от числа карточек, и от размера окна, поэтому меряем сам список, а не считаем на глаз.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el) {
      setOverflow(false);
      return;
    }
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

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
          {SORTS.map((s) => (
            <SortButton key={s.key} active={sort === s.key} onClick={() => setSort(s.key)}>
              {t(s.label)}
            </SortButton>
          ))}
        </div>
      </PanelHead>

      {shown.length === 0 ? (
        <Empty>{t("topPosts.empty")}</Empty>
      ) : (
        <>
          <ul ref={listRef} className="flex gap-3 overflow-x-auto px-4 pb-4">
            {shown.map((p, i) => (
              <li key={p.id} className="w-[150px] shrink-0">
                {/* Щелчок открывает подробную статистику этого видео: на дашборде — шторкой
                    справа, не уходя со страницы; на карточке креатора — переходом с `?video=`.
                    Сама площадка открывается чипом ниже. */}
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(p.id)}
                    className="block w-full text-left transition-opacity hover:opacity-85"
                    title={p.caption || t("common.noCaption")}
                  >
                    <CoverBox post={p} rank={i + 1} />
                  </button>
                ) : (
                  <Link
                    href={`/creator/?id=${p.creatorId}&video=${p.id}`}
                    className="block transition-opacity hover:opacity-85"
                    title={p.caption || t("common.noCaption")}
                  >
                    <CoverBox post={p} rank={i + 1} />
                  </Link>
                )}
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <PlatformIcon platform={p.platform} className="size-3" />
                  <span className="truncate">@{p.handle}</span>
                </a>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {p.publishedAt ? fmtDayAxis(p.publishedAt) : t("topPosts.noDate")}
                </p>
                {showCreator && p.creatorName && (
                  <p className="truncate text-xs" title={p.creatorName}>
                    {p.creatorName}
                  </p>
                )}
                {/* Комментарии тремя числами — та же форма, что в таблице видео и в шторке
                    (владелец, 2026-09-12): снято · не авторских · от других наших. */}
                {cross && (
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <MessageCircleIcon className="size-3 shrink-0" />
                    <CrossCounts info={cross.get(p.id)} platformTotal={p.comments} />
                    <MentionMark handles={cross.get(p.id)?.mentions ?? []} />
                  </p>
                )}
              </li>
            ))}
          </ul>
          {overflow && (
            <p className="pb-3 text-center text-xs text-muted-foreground">{t("topPosts.scrollHint")}</p>
          )}
        </>
      )}
    </Panel>
  );
}

// Обложка с номером места и просмотрами — одна на оба вида щелчка (ссылка и кнопка).
function CoverBox({ post, rank }: { post: PostItem; rank: number }) {
  return (
    <div className="relative">
      <Cover src={post.coverUrl} width={150} className="w-full" />
      <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
        #{rank}
      </span>
      <span
        className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums"
        title={fmtNum(post.views)}
      >
        <EyeIcon className="size-3" />
        {fmtCompact(post.views)}
      </span>
    </div>
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

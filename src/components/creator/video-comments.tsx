"use client";

import { useEffect, useMemo, useState } from "react";
import { HeartIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { listVideoComments, videoCommentsSyncedAt, type CommentSort } from "@/lib/queries";
import { fmtNum } from "@/lib/format";
import { profileUrl } from "@/lib/handle";
import type { Platform, VideoComment } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE = 30;

type Loaded = {
  key: string;
  rows: VideoComment[];
  // Сколько строк у видео всего в базе — по нему решается, нужна ли кнопка «Показать ещё».
  count: number;
  syncedAt: string | null;
};

// Первая буква ника — вместо аватара: площадки картинок авторов не отдают.
function firstLetter(c: VideoComment): string {
  const s = (c.author_handle || c.author_name).trim();
  // Ники бывают с эмодзи: по кодовым точкам, а не по единицам UTF-16.
  return s ? (Array.from(s)[0] ?? "?").toUpperCase() : "?";
}

// Тексты комментариев одного видео (миграция v11). Их бывают сотни, поэтому база отдаёт
// страницами по 30, а поиск фильтрует уже загруженное — искать по всей базе не просили.
export function VideoComments({
  videoId,
  platform,
  total,
  refreshKey,
}: {
  videoId: string;
  platform: Platform;
  // Число комментариев из снимка: сколько их на площадке, а не сколько текстов снято.
  total: number | null;
  // Меняется после обхода — список перечитывается.
  refreshKey: number;
}) {
  const [sort, setSort] = useState<CommentSort>("likes");
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Ответ помнит, чей он и как отсортирован: сменилось видео, сортировка или обход —
  // до нового ответа показываем скелет, а не чужой список.
  const key = `${videoId}|${sort}|${refreshKey}`;

  useEffect(() => {
    let alive = true;
    Promise.all([
      listVideoComments(videoId, { sort, limit: PAGE }),
      videoCommentsSyncedAt(videoId),
    ]).then(
      ([page, syncedAt]) => {
        if (alive) setLoaded({ key, rows: page.rows, count: page.count, syncedAt });
      },
      (e: unknown) => {
        if (alive) setFailed({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [key, videoId, sort]);

  const current = loaded?.key === key ? loaded : null;
  const error = failed !== null && failed.key === key ? failed.error : null;

  const shown = useMemo(() => {
    const rows = current?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (c) =>
        c.text.toLowerCase().includes(q) ||
        c.author_handle.toLowerCase().includes(q) ||
        c.author_name.toLowerCase().includes(q),
    );
  }, [current, search]);

  async function loadMore() {
    if (!current || busy) return;
    setBusy(true);
    try {
      const page = await listVideoComments(videoId, { sort, limit: PAGE, offset: current.rows.length });
      setLoaded((prev) => {
        if (!prev || prev.key !== key) return prev;
        // Сборщик мог дописать строки между страницами — повтор не пускаем: он ломает ключи списка.
        const seen = new Set(prev.rows.map((r) => r.id));
        return { ...prev, rows: [...prev.rows, ...page.rows.filter((r) => !seen.has(r.id))], count: page.count };
      });
    } catch (e: unknown) {
      // Уже показанное не прячем: не дочитали — сообщение, а не пустой блок.
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-muted-foreground">Комментарии · {fmtNum(total)}</h3>
          <p className="text-xs text-muted-foreground">
            {!current ? (
              "…"
            ) : current.syncedAt ? (
              <>
                сняты <LocalTime iso={current.syncedAt} />
              </>
            ) : (
              "тексты ещё не снимались"
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-44">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по тексту и автору"
              className="h-8 pl-8 text-xs"
              aria-label="Поиск по комментариям"
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
            <SortButton active={sort === "likes"} onClick={() => setSort("likes")}>
              Популярные
            </SortButton>
            <SortButton active={sort === "newest"} onClick={() => setSort("newest")}>
              Новые
            </SortButton>
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-destructive">Не удалось прочитать комментарии: {error}</p>
      ) : !current ? (
        <Skeleton className="h-24 w-full" />
      ) : current.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">Комментариев в базе нет</p>
          <p className="text-xs text-muted-foreground">тексты снимаются для видео за последние 7 дней</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Ничего не нашлось.</p>
      ) : (
        <>
          <ul className="divide-y">
            {shown.map((c) => (
              <li key={c.id} className="flex gap-2.5 py-2.5">
                <div className="flex size-7 shrink-0 select-none items-center justify-center rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground">
                  {firstLetter(c)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-xs text-muted-foreground">
                      {c.author_handle ? (
                        <a
                          href={profileUrl(platform, c.author_handle)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-foreground hover:underline"
                        >
                          @{c.author_handle}
                        </a>
                      ) : (
                        <span className="font-semibold text-foreground">{c.author_name || "без имени"}</span>
                      )}
                      {c.author_handle && c.author_name && <span className="ml-1.5">{c.author_name}</span>}
                    </p>
                    {c.likes !== null && (
                      <span
                        className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"
                        title={`лайков: ${fmtNum(c.likes)}`}
                      >
                        <HeartIcon className="size-3" />
                        {fmtNum(c.likes)}
                      </span>
                    )}
                  </div>
                  {/* Перенос строк как у автора, длинный текст не режем — только переносим. */}
                  <p className="whitespace-pre-wrap break-words text-[13px]">{c.text}</p>
                  <p className="text-[11px] text-muted-foreground">
                    <LocalTime iso={c.created_at} mode="date" />
                    {c.replies !== null && c.replies > 0 && ` · ответов: ${fmtNum(c.replies)}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          {current.count > current.rows.length && (
            <div className="pt-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadMore()}>
                {busy ? "Читаю…" : `Показать ещё · осталось ${fmtNum(current.count - current.rows.length)}`}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Тот же чип сортировки, что в «Лучших видео» и «Динамике».
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
      aria-pressed={active}
      className={cn(
        "rounded-md px-2 py-1 transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { HeartIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listRepliesFor,
  listVideoComments,
  videoCommentsSyncedAt,
  type CommentSort,
} from "@/lib/queries";
import { commentMark, type CommentMark } from "@/lib/cross";
import { fmtNum } from "@/lib/format";
import { profileUrl } from "@/lib/handle";
import { useT } from "@/lib/i18n";
import type { Platform, VideoComment } from "@/lib/types";
import { cn } from "@/lib/utils";

// Кто из наших писал этот комментарий — общий набор на весь список: имена наших креаторов
// той же площадки и имя владельца видео (оба в нижнем регистре). Не передан — подсветки нет
// вовсе, и список выглядит ровно как на дашборде.
export type OursMark = { handles: Set<string>; ownerHandle: string };

const PAGE = 30;

type Loaded = {
  key: string;
  rows: VideoComment[];
  // Сколько корневых строк у видео всего в базе — по нему решается, нужна ли кнопка «Показать ещё».
  count: number;
  syncedAt: string | null;
};

// Развёрнутая ветка ответов одного корневого комментария.
// Сколько ответов видно сразу; остальные — по кнопке (владелец, 2026-09-12).
const FIRST_REPLIES = 3;

type Branch =
  | { status: "loading" }
  | { status: "ready"; rows: VideoComment[] }
  | { status: "error"; error: string };

// Первая буква ника — вместо аватара: площадки картинок авторов не отдают.
function firstLetter(c: VideoComment): string {
  const s = (c.author_handle || c.author_name).trim();
  // Ники бывают с эмодзи: по кодовым точкам, а не по единицам UTF-16.
  return s ? (Array.from(s)[0] ?? "?").toUpperCase() : "?";
}

// Совпадение с поиском: текст и оба имени автора.
function matches(c: VideoComment, q: string): boolean {
  return (
    c.text.toLowerCase().includes(q) ||
    c.author_handle.toLowerCase().includes(q) ||
    c.author_name.toLowerCase().includes(q)
  );
}

// Тексты комментариев одного видео (миграция v11). Список — только корневые: их бывают
// сотни, поэтому база отдаёт страницами по 30, а поиск фильтрует уже загруженное —
// искать по всей базе не просили. Ответы лежат в той же таблице и приходят отдельным
// запросом, когда ветку разворачивают.
export function VideoComments({
  videoId,
  platform,
  total,
  ours,
  refreshKey,
  mark,
}: {
  videoId: string;
  platform: Platform;
  // Число комментариев из снимка: сколько их на площадке, а не сколько текстов снято.
  total: number | null;
  // «Наше» ли видео: у не наших сборщик тексты обычно не снимает — пустота здесь не
  // потеря, а правило, и сказать об этом надо прямо (миграция v13).
  ours: boolean;
  // Меняется после обхода — список перечитывается.
  refreshKey: number;
  // Подсветка своих (миграция v29): жёлтая метка у комментария другого нашего
  // креатора и приглушённая — у комментария автора самого видео. Не задана — списка это
  // не касается.
  mark?: OursMark;
}) {
  const t = useT();
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
          <h3 className="text-xs font-medium text-muted-foreground">
            {t("comments.head")} · {fmtNum(total)}
          </h3>
          <p className="text-xs text-muted-foreground">
            {!current ? (
              t("common.ellipsis")
            ) : current.syncedAt ? (
              <>
                {t("comments.takenAt")} <LocalTime iso={current.syncedAt} />
              </>
            ) : (
              t("comments.neverTaken")
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-44">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("comments.searchPlaceholder")}
              className="h-8 pl-8 text-xs"
              aria-label={t("comments.searchAria")}
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5 text-xs">
            <SortButton active={sort === "likes"} onClick={() => setSort("likes")}>
              {t("comments.sortPopular")}
            </SortButton>
            <SortButton active={sort === "newest"} onClick={() => setSort("newest")}>
              {t("comments.sortNew")}
            </SortButton>
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-destructive">{t("comments.readError", { error })}</p>
      ) : !current ? (
        <Skeleton className="h-24 w-full" />
      ) : current.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          {/* Не наше видео, к которому сборщик за текстами и не ходил: обычная пустота
              выглядела бы поломкой, а это правило. Сняли по особой просьбе — строки есть,
              и сюда мы уже не попадаем. */}
          {!ours && current.count === 0 && !current.syncedAt ? (
            <p className="text-sm text-muted-foreground">{t("comments.notOursNote")}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("comments.emptyTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("comments.emptyHint")}</p>
            </>
          )}
        </div>
      ) : (
        // key — ключ списка: сменилась сортировка или прошёл обход, React пересоздаёт
        // список, и развёрнутые ветки сворачиваются сами, без сброса руками.
        <CommentList
          key={key}
          videoId={videoId}
          platform={platform}
          rows={current.rows}
          search={search}
          more={current.count - current.rows.length}
          busy={busy}
          mark={mark}
          onMore={() => void loadMore()}
        />
      )}
    </div>
  );
}

// Список корневых комментариев с ветками ответов. Отдельным компонентом ради ключа:
// развёрнутые ветки принадлежат конкретному списку, и пересоздание — самый честный
// способ их свернуть при смене сортировки или после обхода.
function CommentList({
  videoId,
  platform,
  rows,
  search,
  more,
  busy,
  mark,
  onMore,
}: {
  videoId: string;
  platform: Platform;
  rows: VideoComment[];
  search: string;
  // Сколько корневых в базе ещё не прочитано: больше нуля — есть «Показать ещё».
  more: number;
  busy: boolean;
  mark?: OursMark;
  onMore: () => void;
}) {
  // Какие ветки развёрнуты и что в них загружено. Свёрнутая ветка помнит ответы —
  // второй раз в базу не ходим.
  const t = useT();
  // Сколько ответов ветки раскрыто: по умолчанию первые FIRST_REPLIES, по кнопке — все
  // (владелец, 2026-09-12: «ответы не должны быть скрыты — показывай сразу первые три»).
  const [full, setFull] = useState<Record<string, boolean>>({});
  const [branches, setBranches] = useState<Record<string, Branch>>({});

  // Ветки грузятся вместе со страницей корневых — одним запросом на всех, у кого есть ответы.
  const wanted = useMemo(
    () => rows.filter((c) => (c.replies ?? 0) > 0).map((c) => c.id).join(","),
    [rows],
  );
  useEffect(() => {
    const ids = wanted === "" ? [] : wanted.split(",");
    if (ids.length === 0) return;
    let alive = true;
    // Пометку «грузится» не ставим: пока записи нет, ветка и так показывает скелет, а
    // синхронный setState внутри эффекта запрещён правилом React Compiler.
    listRepliesFor(videoId, ids).then(
      (all) => {
        if (!alive) return;
        const byParent = new Map<string, VideoComment[]>();
        for (const r of all) {
          const key = r.parent_id ?? "";
          const arr = byParent.get(key) ?? [];
          arr.push(r);
          byParent.set(key, arr);
        }
        setBranches((prev) => {
          const next = { ...prev };
          for (const id of ids) next[id] = { status: "ready", rows: byParent.get(id) ?? [] };
          return next;
        });
      },
      (e: unknown) => {
        if (!alive) return;
        const error = e instanceof Error ? e.message : String(e);
        setBranches((prev) => {
          const next = { ...prev };
          for (const id of ids) next[id] = { status: "error", error };
          return next;
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [videoId, wanted]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => {
      if (matches(c, q)) return true;
      // Ответы приезжают вместе с корневыми, поэтому ищутся всегда.
      const branch = branches[c.id];
      return branch?.status === "ready" && branch.rows.some((r) => matches(r, q));
    });
  }, [rows, search, branches]);

  if (shown.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {t("comments.nothingFound")}
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y">
        {shown.map((c) => {
          const hasReplies = c.replies !== null && c.replies > 0;
          return (
            <li key={c.id} className="py-2.5">
              <CommentRow
                c={c}
                platform={platform}
                mark={mark}
                tail={
                  hasReplies && (
                    <>
                      {" · "}
                      <span>
                        {t("comments.replies")} · {fmtNum(c.replies)}
                      </span>
                    </>
                  )
                }
              >
                {hasReplies && (
                  <Replies
                    branch={branches[c.id]}
                    platform={platform}
                    total={c.replies ?? 0}
                    mark={mark}
                    replyTo={c.author_handle}
                    full={full[c.id] === true}
                    onFull={() => setFull((prev) => ({ ...prev, [c.id]: true }))}
                  />
                )}
              </CommentRow>
            </li>
          );
        })}
      </ul>

      {more > 0 && (
        <div className="pt-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={onMore}>
            {busy ? t("comments.reading") : t("comments.more", { n: fmtNum(more) })}
          </Button>
        </div>
      )}
    </>
  );
}

// Строка комментария — одна и та же у корневого и у ответа: @ник, имя, текст, лайки, дата.
// small — вид внутри ветки: кружок и текст мельче. tail дописывается к дате (кнопка веток),
// children встают под строкой с отступом её колонки — там и живёт сама ветка.
//
// replyTo — имя автора корневого комментария: ставится только у ответов и только когда имя
// известно (владелец, 2026-09-11). Без него ответ читался бы как обычный комментарий, а
// отступ ветки — как случайный отступ.
function CommentRow({
  c,
  platform,
  small = false,
  mark,
  replyTo,
  tail,
  children,
}: {
  c: VideoComment;
  platform: Platform;
  small?: boolean;
  mark?: OursMark;
  replyTo?: string;
  tail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const t = useT();
  // 🔴 Комментарий другого нашего креатора и комментарий автора видео под своим же роликом —
  // разные вещи, и метки у них разные: жёлтая «наш креатор» и приглушённая «автор видео».
  const kind: CommentMark = mark ? commentMark(c.author_handle, mark.handles, mark.ownerHandle) : null;
  return (
    <div className={cn("flex gap-2.5", kind === "cross" && "rounded-lg bg-amber-500/10 p-2")}>
      <div
        className={cn(
          "flex shrink-0 select-none items-center justify-center rounded-full font-medium uppercase",
          kind === "cross"
            ? "bg-amber-500/25 text-amber-700 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
          small ? "size-5 text-[10px]" : "size-7 text-xs",
        )}
      >
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
              <span className="font-semibold text-foreground">
                {c.author_name || t("comments.noName")}
              </span>
            )}
            {c.author_handle && c.author_name && <span className="ml-1.5">{c.author_name}</span>}
            {kind === "cross" && (
              <span
                className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                title={t("cross.commentCrossTitle", { handle: `@${c.author_handle}` })}
              >
                {t("cross.commentCross")}
              </span>
            )}
            {kind === "self" && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                {t("cross.commentSelf")}
              </span>
            )}
            {replyTo && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {t("comments.replyTo", { handle: `@${replyTo}` })}
              </span>
            )}
          </p>
          {c.likes !== null && (
            <span
              className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"
              title={t("comments.likesTitle", { n: fmtNum(c.likes) })}
            >
              <HeartIcon className="size-3" />
              {fmtNum(c.likes)}
            </span>
          )}
        </div>
        {/* Перенос строк как у автора, длинный текст не режем — только переносим. */}
        <p className={cn("whitespace-pre-wrap break-words", small ? "text-xs" : "text-[13px]")}>{c.text}</p>
        <p className="text-[11px] text-muted-foreground">
          <LocalTime iso={c.created_at} mode="date" />
          {tail}
        </p>
        {children}
      </div>
    </div>
  );
}

// Ветка ответов под корневым: полоса слева и отступ, внутри — те же строки помельче.
// total — сколько ответов у комментария на площадке: снято бывает меньше (сборщик
// берёт до 20), и тогда об этом говорится прямо, чтобы разницу не приняли за потерю.
//
// 🔴 Сдвиг и полоса — единственное, чем ответ отличается от корневого на глаз (владелец,
// 2026-09-11: «непонятно, что это ответ»), поэтому отступ заметный, а цвет полосы — `border`,
// тот же, что у всех разделителей: в тёмной теме он темнеет вместе с ними.
function Replies({
  branch,
  platform,
  total,
  mark,
  replyTo,
  full = false,
  onFull,
}: {
  branch: Branch | undefined;
  platform: Platform;
  total: number;
  mark?: OursMark;
  // Имя автора корневого комментария; пустое — пометки «в ответ @ник» не будет.
  replyTo?: string;
  // Раскрыта ли ветка целиком: по умолчанию видны первые FIRST_REPLIES.
  full?: boolean;
  onFull?: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 border-l border-border pl-6">
      {branch === undefined || branch.status === "loading" ? (
        <Skeleton className="h-10 w-full" />
      ) : branch.status === "error" ? (
        <p className="text-xs text-destructive">
          {t("comments.repliesError", { error: branch.error })}
        </p>
      ) : branch.rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("comments.repliesNotTaken")}</p>
      ) : (
        <>
          <ul className="space-y-2.5">
            {(full ? branch.rows : branch.rows.slice(0, FIRST_REPLIES)).map((r) => (
              <li key={r.id}>
                <CommentRow
                  c={r}
                  platform={platform}
                  small
                  mark={mark}
                  replyTo={replyTo ? replyTo : undefined}
                />
              </li>
            ))}
          </ul>
          {!full && branch.rows.length > FIRST_REPLIES && (
            <button
              type="button"
              onClick={onFull}
              className="pt-2 text-[11px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("comments.moreReplies", { n: fmtNum(branch.rows.length - FIRST_REPLIES) })}
            </button>
          )}
          {(full || branch.rows.length <= FIRST_REPLIES) && branch.rows.length < total && (
            <p className="pt-2 text-[11px] text-muted-foreground">
              {t("comments.shownOf", { shown: fmtNum(branch.rows.length), total: fmtNum(total) })}
            </p>
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

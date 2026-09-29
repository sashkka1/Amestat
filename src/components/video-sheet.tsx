"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { XIcon } from "lucide-react";
import { CreatorLabel } from "@/components/creator-label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { VideoPanel, activeRows, panelMedians, type MetricKey } from "@/components/creator/video-panel";
import type { OursMark } from "@/components/creator/video-comments";
import type { VideoTableRow } from "@/components/stats/videos-table";
import { videoStatsBetween } from "@/lib/queries";
import type { CrossInfo } from "@/lib/cross";
import { useT } from "@/lib/i18n";
import type { Scope } from "@/lib/dashboard-prefs";
import type { PeriodRange } from "@/lib/period";
import type { Creator, VideoStats } from "@/lib/types";
import type { VideoState } from "@/lib/video-state";

// Видео в выдвижной шторке справа — на ВСЕХ страницах (владелец, 2026-09-12: «видео всегда
// открывается шторкой справа»). Содержимое — тот же `VideoPanel`: разъехаться им нечем.
//
// 🔴 Шторка — простая панель в портале, а НЕ `Dialog` радикса (владелец, 2026-09-29: в
// шторке не переводился выделенный комментарий). Модальный Dialog, пока открыт, вешает
// `aria-hidden` на всю остальную страницу, `pointer-events: none` на body, запирает фокус
// в себе и закрывается от нажатия на любой чужой элемент — значок переводчика рядом с
// выделением от этого не работает. Здесь из поведения Dialog оставлено только нужное:
// затемнение (клик по нему закрывает), Escape и запрет прокрутки страницы под шторкой.
//
// Данные читаются лениво, при открытии: дашборд про креатора этого видео не знает ничего,
// кроме id, а звать `video_stats_between` на всех подряд ради панели, которую могут и не
// открыть, — лишняя тысяча строк на каждую смену срока.
//
// ⚠️ Карточка креатора те же строки уже прочитала и отдаёт их свойством `rows` — тогда
// шторка не ходит в базу вовсе. Второй такой запрос дал бы те же цифры, но открытие ролика
// ждало бы его на ровном месте.

type Loaded = { key: string; rows: VideoStats[] };

// Строки за срок нет: видео вышло позже конца срока или снимков в нём не было. Тогда панель
// показывает текущие счётчики из `videos_with_latest` (их дашборд уже прочитал), а приросты
// нулевые — сравнивать не с чем, и об этом говорит подпись под ссылкой.
function fallbackRow(video: VideoTableRow): VideoStats {
  return {
    video_id: video.id,
    published_at: video.publishedAt,
    caption: video.caption,
    cover_url: video.coverUrl,
    url: video.url,
    ours: video.state === "ours",
    // Отметка «похоже, удалено» приходит со строкой дашборда (миграция v33): за срок
    // строки нет, а знать об удалении панель обязана.
    gone_at: video.goneAt,
    views_now: video.views,
    likes_now: video.likes,
    comments_now: video.comments,
    shares_now: video.shares,
    saves_now: video.saves,
    views_delta: 0,
    likes_delta: 0,
    comments_delta: 0,
    shares_delta: 0,
    saves_delta: 0,
  };
}

const NO_MEDIANS: Record<MetricKey, number | null> = {
  views: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
};

export function VideoSheet({
  video,
  creator,
  range,
  scope,
  refreshKey,
  onState,
  onClose,
  cross,
  mark,
  rows,
}: {
  // Строка таблицы дашборда: null — шторка закрыта.
  video: VideoTableRow | null;
  // Креатор этого видео: его подпись стоит в шапке шторки и ведёт на карточку.
  creator: Creator | null;
  range: PeriodRange | null;
  scope: Scope;
  // Меняется после обхода — панель перечитывает историю и комментарии.
  refreshKey: number;
  // Состояние меняется тем же переключателем, что в таблице; строку дашборда правит хозяин.
  onState: (videoId: string, next: VideoState, before: VideoState) => void;
  onClose: () => void;
  // Перекрёстность этого видео и подсветка своих в комментариях (миграция v29).
  cross?: CrossInfo;
  mark?: OursMark;
  // Строки `video_stats_between` за тот же срок, уже прочитанные хозяином (карточка
  // креатора). Заданы — шторка своего запроса не делает.
  rows?: VideoStats[] | null;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string } | null>(null);

  const creatorId = creator?.id ?? null;
  const open = video !== null && creator !== null;
  const key =
    open && creatorId && range && !rows
      ? `${creatorId}|${range.from.getTime()}|${range.to.getTime()}|${scope}|${refreshKey}`
      : null;

  useEffect(() => {
    if (key === null || !creatorId || !range) return;
    let alive = true;
    videoStatsBetween(creatorId, range, scope).then(
      (rows) => {
        if (alive) setLoaded({ key, rows });
      },
      (e: unknown) => {
        if (alive) setFailed({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
    // range — объект Date, пересобирается каждый рендер; ключ сводит его к строке.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, creatorId, scope]);

  // Escape закрывает шторку, как закрывал Dialog. Слои радикса внутри (меню, выпадашки)
  // гасят Escape у себя и помечают событие `defaultPrevented` — тогда шторка остаётся.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Страница под шторкой не прокручивается, как было при Dialog. Место полосы прокрутки
  // держим отступом, иначе страница под затемнением прыгнет вбок на её ширину.
  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const before = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = before.overflow;
      body.style.paddingRight = before.paddingRight;
    };
  }, [open]);

  // Свои строки хозяина или свои же прочитанные — одно и то же для всего, что ниже.
  const current: Loaded | null = useMemo(
    () => (rows ? { key: "own", rows } : key !== null && loaded?.key === key ? loaded : null),
    [rows, key, loaded],
  );
  const error = key !== null && failed?.key === key ? failed.error : null;

  const shown = useMemo(() => {
    if (!video || !range) return null;
    if (!current) return null;
    const row = current.rows.find((r) => r.video_id === video.id) ?? null;
    return {
      // Состояние ведёт дашборд (оно там же и правится оптимистично), поэтому `ours` в строке
      // приводим к нему: иначе «не наше» в комментариях спорило бы с зелёным переключателем.
      row: { ...(row ?? fallbackRow(video)), ours: video.state === "ours" },
      medians: panelMedians(activeRows(current.rows, range)),
      missing: row === null,
    };
  }, [current, video, range]);

  if (!open || !video || !creator) return null;

  return createPortal(
    <>
      {/* Затемнение — то же, что у `DialogOverlay`; клик по нему закрывает шторку. */}
      <div
        className="fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        aria-label={creator.display_name || creator.handle}
        /* Ширина: около половины широкого монитора, на узком — почти весь экран
           (владелец, 2026-09-12). */
        className="fixed inset-y-0 right-0 z-50 flex h-full w-[min(48rem,92vw)] flex-col rounded-l-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10"
      >
        {/* Шапка шторки: чей ролик и куда идти за подробностями по креатору. */}
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <Link
            href={`/creator/?id=${creator.id}&video=${video.id}`}
            className="min-w-0 font-heading text-base leading-none font-medium hover:underline"
            title={t("videoSheet.openCreator")}
          >
            <CreatorLabel
              platform={creator.platform}
              name={creator.display_name}
              handle={creator.handle}
            />
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <XIcon />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="text-sm text-destructive">{t("videoSheet.loadError", { error })}</p>
          ) : shown ? (
            <VideoPanel
              plain
              row={shown.row}
              state={video.state}
              onState={(next) => onState(video.id, next, video.state)}
              medians={shown.missing ? NO_MEDIANS : shown.medians}
              platform={creator.platform}
              refreshKey={refreshKey}
              note={shown.missing ? t("videoSheet.notInRange") : null}
              cross={cross}
              mark={mark}
            />
          ) : (
            <div className="flex flex-col gap-4" aria-busy="true">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-36 w-full" />
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

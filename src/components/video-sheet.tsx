"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { XIcon } from "lucide-react";
import { CreatorLabel } from "@/components/creator-label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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

// Видео дашборда в выдвижной шторке справа (владелец, 2026-09-09: «клик по видео должен
// открывать ту же подробную статистику, что на странице креатора»). Содержимое — тот же
// `VideoPanel`, что встроен в карточку креатора: разъехаться им нечем.
//
// ⚠️ Sheet в `components/ui/` нет, поэтому шторка — это `Dialog` радикса, поставленный на
// правый край во всю высоту. Появится настоящий Sheet — меняется только эта обёртка.
//
// Данные читаются лениво, при открытии: дашборд про креатора этого видео не знает ничего,
// кроме id, а звать `video_stats_between` на всех подряд ради панели, которую могут и не
// открыть, — лишняя тысяча строк на каждую смену срока.

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
  // Перекрёстность этого видео и подсветка своих в комментариях — только со страницы
  // «Amestat Test»; дашборд их не передаёт, и шторка там прежняя.
  cross?: CrossInfo;
  mark?: OursMark;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: string } | null>(null);

  const creatorId = creator?.id ?? null;
  const open = video !== null && creator !== null;
  const key =
    open && creatorId && range
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

  const current = key !== null && loaded?.key === key ? loaded : null;
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open && video && creator && (
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="inset-y-0 right-0 left-auto top-0 flex h-full w-full max-w-[calc(100%-2rem)] flex-col translate-x-0 translate-y-0 gap-0 rounded-none rounded-l-xl p-0 data-open:slide-in-from-right data-closed:slide-out-to-right sm:max-w-[42rem]"
        >
          {/* Шапка шторки: чей ролик и куда идти за подробностями по креатору. */}
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <DialogTitle asChild>
              <Link
                href={`/creator/?id=${creator.id}&video=${video.id}`}
                className="min-w-0 hover:underline"
                title={t("videoSheet.openCreator")}
              >
                <CreatorLabel
                  platform={creator.platform}
                  name={creator.display_name}
                  handle={creator.handle}
                />
              </Link>
            </DialogTitle>
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
        </DialogContent>
      )}
    </Dialog>
  );
}

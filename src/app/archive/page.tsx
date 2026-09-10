"use client";

import { useMemo, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { Avatar } from "@/components/avatar";
import { CreatorLabel } from "@/components/creator-label";
import { PlatformChip } from "@/components/platform";
import { PlatformSwitch } from "@/components/platform-switch";
import { LocalTime } from "@/components/local-time";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { restoreCreator } from "@/lib/api/creators";
import { listArchive } from "@/lib/queries";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { matchesPlatform, platformFilterLabel, usePlatformFilter } from "@/lib/platform-filter";
import { useLoader } from "@/lib/use-loader";

export default function ArchivePage() {
  return (
    <AuthGate role="admin">
      <ArchiveScreen />
    </AuthGate>
  );
}

// Архив пишет триггер при удалении креатора: строка помнит, кто удалил и каким менеджерам
// креатор принадлежал.
//
// Кнопка «Вернуть» поднимает карточку обратно (миграция v25, владелец 2026-09-10): до неё
// приходилось идти на страницу креатора, копировать ссылку и заводить заново. Снимки, видео
// и комментарии ушли каскадом и не восстанавливаются — их соберёт ближайший обход.
//
// Проверки на роль у кнопки нет намеренно: страница целиком под `AuthGate role="admin"`,
// а сама функция базы первой строкой спрашивает `is_admin()`.
function ArchiveScreen() {
  const t = useT();
  const { data, error, loading, reload } = useLoader(listArchive, []);
  // Подтверждение — тот же приём, что у удаления креатора и менеджера: полоса над списком
  // с вопросом и двумя кнопками, а не `confirm()` браузера.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Переключатель тот же, что на дашборде и в «Креаторах»: положение общее через localStorage.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;

  // Счётчик «N записей» считает по выбранной площадке — как и всё, что ниже.
  const list = useMemo(
    () => (data ?? []).filter((a) => matchesPlatform(platformFilter, a.platform)),
    [data, platformFilter],
  );


  async function restore(id: string, handle: string) {
    setBusy(true);
    const res = await restoreCreator(id);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setConfirmId(null);
    toast.success(t("archive.restored", { handle }));
    reload();
  }

  return (
    <Page
      title={t("archive.title")}
      subtitle={
        platformFilter === "all"
          ? t("archive.subtitle")
          : t("archive.subtitlePlatform", { platform: platformFilterLabel(platformFilter) })
      }
      actions={<PlatformSwitch state={platform} />}
    >
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton blocks={1} />
      ) : data ? (
        <>
        <Panel>
          <PanelHead
            title={t("archive.panelTitle")}
            subtitle={t("archive.count", {
              n: fmtNum(list.length),
              records: t.plural("records", list.length),
            })}
          />
          {list.length === 0 ? (
            <Empty>
              {data.length === 0 ? t("archive.emptyNone") : t("archive.emptyPlatform")}
            </Empty>
          ) : (
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-muted-foreground">{t("table.creator")}</TableHead>
                  <TableHead className="text-muted-foreground">{t("table.platform")}</TableHead>
                  <TableHead className="text-muted-foreground">{t("archive.wasWithManagers")}</TableHead>
                  <TableHead className="text-muted-foreground">{t("archive.added")}</TableHead>
                  <TableHead className="text-muted-foreground">{t("archive.deleted")}</TableHead>
                  <TableHead className="text-muted-foreground">{t("archive.deletedBy")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => {
                  const name = a.display_name || a.handle;
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <a
                          href={a.profile_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 hover:underline"
                        >
                          <Avatar src={a.avatar_url} name={name} size={28} />
                          <CreatorLabel
                            platform={a.platform}
                            name={a.display_name}
                            handle={a.handle}
                            className="font-medium"
                          />
                        </a>
                      </TableCell>
                      <TableCell>
                        <PlatformChip platform={a.platform} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {a.managers.length > 0 ? a.managers.join(", ") : t("archive.noManagers")}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <LocalTime iso={a.added_at} mode="date" />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <LocalTime iso={a.deleted_at} />
                      </TableCell>
                      <TableCell>{a.deleted_by_login || t("archive.unknown")}</TableCell>
                      <TableCell className="text-right">
                        {/* Подтверждение стоит В СТРОКЕ, а не полосой над таблицей: строк в
                            архиве десятки, и вопрос наверху просто не попадал в поле зрения —
                            нажатие выглядело как «кнопка не работает» (владелец, 2026-09-10). */}
                        {confirmId === a.id ? (
                          <span className="flex items-center justify-end gap-1">
                            <span className="mr-1 text-xs text-muted-foreground">
                              {t("archive.restoreConfirm", { handle: a.handle })}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmId(null)}
                              disabled={busy}
                            >
                              {t("common.no")}
                            </Button>
                            <Button size="sm" onClick={() => restore(a.id, a.handle)} disabled={busy}>
                              {busy ? t("archive.restoring") : t("archive.restore")}
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmId(a.id)}
                            disabled={busy}
                            aria-label={t("archive.restore")}
                          >
                            <RotateCcwIcon data-icon="inline-start" />
                            {t("archive.restore")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
        </>
      ) : null}
    </Page>
  );
}

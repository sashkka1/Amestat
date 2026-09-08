"use client";

import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { Avatar } from "@/components/avatar";
import { PlatformChip } from "@/components/platform";
import { LocalTime } from "@/components/local-time";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listArchive } from "@/lib/queries";
import { fmtNum } from "@/lib/format";
import { useLoader } from "@/lib/use-loader";

export default function ArchivePage() {
  return (
    <AuthGate role="admin">
      <ArchiveScreen />
    </AuthGate>
  );
}

// Архив пишет триггер при удалении креатора: строка помнит, кто удалил и каким менеджерам
// креатор принадлежал. Снимки и видео уходят каскадом — вернуть креатора отсюда нельзя.
function ArchiveScreen() {
  const { data, error, loading } = useLoader(listArchive, []);

  return (
    <Page title="Архив" subtitle="Удалённые креаторы: кто и когда">
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton blocks={1} />
      ) : data ? (
        <Panel>
          <PanelHead title="Удалённые" subtitle={`${fmtNum(data.length)} записей`} />
          {data.length === 0 ? (
            <Empty>Никого не удаляли.</Empty>
          ) : (
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-muted-foreground">Креатор</TableHead>
                  <TableHead className="text-muted-foreground">Площадка</TableHead>
                  <TableHead className="text-muted-foreground">Был у менеджеров</TableHead>
                  <TableHead className="text-muted-foreground">Добавлен</TableHead>
                  <TableHead className="text-muted-foreground">Удалён</TableHead>
                  <TableHead className="text-muted-foreground">Кто удалил</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((a) => {
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
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{name}</span>
                            <span className="block truncate text-xs text-muted-foreground">@{a.handle}</span>
                          </span>
                        </a>
                      </TableCell>
                      <TableCell>
                        <PlatformChip platform={a.platform} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {a.managers.length > 0 ? a.managers.join(", ") : "ни у кого"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <LocalTime iso={a.added_at} mode="date" />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <LocalTime iso={a.deleted_at} />
                      </TableCell>
                      <TableCell>{a.deleted_by_login || "неизвестно"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      ) : null}
    </Page>
  );
}

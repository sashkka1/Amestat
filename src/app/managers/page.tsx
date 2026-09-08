"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { LocalTime } from "@/components/local-time";
import { InviteDialog } from "@/components/managers/invite-dialog";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deleteInvite, daysAgoText, inviteState, listInvites } from "@/lib/api/invites";
import { listManagers, listProfiles } from "@/lib/api/profiles";
import { listCreatorManagers } from "@/lib/queries";
import { fmtDate, fmtNum } from "@/lib/format";
import { useLoader } from "@/lib/use-loader";
import type { CreatorManager, Invite, Profile } from "@/lib/types";

type Data = {
  managers: Profile[];
  all: Profile[];
  links: CreatorManager[];
  invites: Invite[];
};

async function loadData(): Promise<Data> {
  const [managers, all, links, invites] = await Promise.all([
    listManagers(),
    listProfiles(),
    listCreatorManagers(),
    listInvites(),
  ]);
  return { managers, all, links, invites };
}

export default function ManagersPage() {
  return (
    <AuthGate role="admin">
      <ManagersScreen />
    </AuthGate>
  );
}

function ManagersScreen() {
  const { data, error, loading, reload } = useLoader(loadData, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data?.links ?? []) m.set(l.manager_id, (m.get(l.manager_id) ?? 0) + 1);
    return m;
  }, [data]);

  const loginById = useMemo(
    () => new Map((data?.all ?? []).map((p) => [p.user_id, p.login])),
    [data],
  );

  return (
    <Page
      title="Креатор-менеджеры"
      subtitle="Кто ведёт креаторов и по каким ссылкам зарегистрировался"
      actions={<InviteDialog onCreated={reload} />}
    >
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton blocks={2} />
      ) : data ? (
        <>
          <Panel>
            <PanelHead title="Менеджеры" subtitle={`${fmtNum(data.managers.length)} человек`} />
            {data.managers.length === 0 ? (
              <Empty>Менеджеров пока нет — выпустите ссылку регистрации.</Empty>
            ) : (
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-muted-foreground">Логин</TableHead>
                    <TableHead className="text-muted-foreground">Имя</TableHead>
                    <TableHead className="text-right text-muted-foreground">Креаторов</TableHead>
                    <TableHead className="text-right text-muted-foreground">Зарегистрирован</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.managers.map((m) => (
                    <TableRow key={m.user_id}>
                      <TableCell>
                        <Link href={`/manager/?id=${m.user_id}`} className="font-medium hover:underline">
                          {m.login}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {m.display_name.trim() || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(counts.get(m.user_id) ?? 0)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        <LocalTime iso={m.created_at} mode="date" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>

          <InvitesPanel invites={data.invites} loginById={loginById} onChanged={reload} />
        </>
      ) : null}
    </Page>
  );
}

function InvitesPanel({
  invites,
  loginById,
  onChanged,
}: {
  invites: Invite[];
  loginById: Map<string, string>;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function remove(id: string) {
    setBusyId(id);
    const res = await deleteInvite(id);
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Ссылка удалена");
    onChanged();
  }

  return (
    <Panel>
      <PanelHead title="Журнал ссылок" subtitle={`${fmtNum(invites.length)} выпущено`} />
      {invites.length === 0 ? (
        <Empty>Ссылок пока не выпускали.</Empty>
      ) : (
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="text-muted-foreground">Заметка</TableHead>
              <TableHead className="text-muted-foreground">Когда отправлена</TableHead>
              <TableHead className="text-muted-foreground">Состояние</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((inv) => {
              const state = inviteState(inv, loginById);
              return (
                <TableRow key={inv.id}>
                  <TableCell>{inv.note.trim() || <span className="text-muted-foreground">без заметки</span>}</TableCell>
                  <TableCell className="text-muted-foreground">{daysAgoText(inv.created_at)}</TableCell>
                  <TableCell>
                    {state.kind === "used" ? (
                      <span className="text-[var(--up)]">
                        использована: {state.login}, {fmtDate(state.at)}
                      </span>
                    ) : state.kind === "expired" ? (
                      <span className="text-muted-foreground">истекла {fmtDate(inv.expires_at)}</span>
                    ) : (
                      <span>не использована, годна до {fmtDate(inv.expires_at)}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      title="Удалить ссылку"
                      aria-label="Удалить ссылку"
                      disabled={busyId === inv.id}
                      onClick={() => void remove(inv.id)}
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

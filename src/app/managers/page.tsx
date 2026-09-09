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
import { useT } from "@/lib/i18n";
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
  const t = useT();
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
      title={t("managers.title")}
      subtitle={t("managers.subtitle")}
      actions={<InviteDialog onCreated={reload} />}
    >
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton blocks={2} />
      ) : data ? (
        <>
          <Panel>
            <PanelHead
              title={t("managers.panelTitle")}
              subtitle={t("managers.count", {
                n: fmtNum(data.managers.length),
                people: t.plural("people", data.managers.length),
              })}
            />
            {data.managers.length === 0 ? (
              <Empty>{t("managers.empty")}</Empty>
            ) : (
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-muted-foreground">{t("table.login")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("table.name")}</TableHead>
                    <TableHead className="text-right text-muted-foreground">
                      {t("managers.creatorsCount")}
                    </TableHead>
                    <TableHead className="text-right text-muted-foreground">
                      {t("managers.registered")}
                    </TableHead>
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
  const t = useT();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function remove(id: string) {
    setBusyId(id);
    const res = await deleteInvite(id);
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("invites.deleted"));
    onChanged();
  }

  return (
    <Panel>
      <PanelHead
        title={t("invites.panelTitle")}
        subtitle={t("invites.issued", { n: fmtNum(invites.length) })}
      />
      {invites.length === 0 ? (
        <Empty>{t("invites.empty")}</Empty>
      ) : (
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="text-muted-foreground">{t("invites.note")}</TableHead>
              <TableHead className="text-muted-foreground">{t("invites.sentWhen")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.status")}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((inv) => {
              const state = inviteState(inv, loginById);
              return (
                <TableRow key={inv.id}>
                  <TableCell>
                    {inv.note.trim() || (
                      <span className="text-muted-foreground">{t("invites.noNote")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{daysAgoText(inv.created_at)}</TableCell>
                  <TableCell>
                    {state.kind === "used" ? (
                      <span className="text-[var(--up)]">
                        {t("invites.used", { login: state.login, date: fmtDate(state.at) })}
                      </span>
                    ) : state.kind === "expired" ? (
                      <span className="text-muted-foreground">
                        {t("invites.expired", { date: fmtDate(inv.expires_at) })}
                      </span>
                    ) : (
                      <span>{t("invites.open", { date: fmtDate(inv.expires_at) })}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      title={t("invites.deleteTitle")}
                      aria-label={t("invites.deleteTitle")}
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

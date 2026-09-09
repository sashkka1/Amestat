"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AuthGate } from "@/components/auth-gate";
import { Page, PageError, PageSkeleton } from "@/components/page";
import { Avatar } from "@/components/avatar";
import { PlatformChip } from "@/components/platform";
import { PlatformSwitch } from "@/components/platform-switch";
import { LocalTime } from "@/components/local-time";
import { Panel, PanelHead, Empty } from "@/components/stats/panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { assignManager, unassignManager } from "@/lib/api/managers";
import {
  deleteManager,
  profileById,
  profileName,
  setManagerPassword,
  updateDisplayName,
} from "@/lib/api/profiles";
import { listCreatorManagers, listCreators } from "@/lib/queries";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { matchesPlatform, usePlatformFilter } from "@/lib/platform-filter";
import { useLoader } from "@/lib/use-loader";
import type { Creator, Profile } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Data = { manager: Profile | null; creators: Creator[]; assigned: Set<string> };

async function loadData(id: string): Promise<Data> {
  const [manager, creators, links] = await Promise.all([
    profileById(id),
    listCreators(),
    listCreatorManagers(),
  ]);
  return {
    manager,
    creators,
    assigned: new Set(links.filter((l) => l.manager_id === id).map((l) => l.creator_id)),
  };
}

export default function ManagerPage() {
  const t = useT();
  return (
    <AuthGate role="admin">
      <Suspense
        fallback={
          <Page title={t("manager.title")}>
            <PageSkeleton blocks={1} />
          </Page>
        }
      >
        <ManagerRoute />
      </Suspense>
    </AuthGate>
  );
}

function ManagerRoute() {
  const t = useT();
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (!UUID_RE.test(id)) {
    return (
      <Page title={t("manager.title")}>
        <p className="text-sm text-muted-foreground">{t("manager.noId")}</p>
      </Page>
    );
  }
  return <ManagerView id={id} />;
}

function ManagerView({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const { data, error, loading, reload } = useLoader(() => loadData(id), [id]);
  const manager = data?.manager ?? null;

  const [name, setName] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Radix Select пустую строку за значение не считает — держим undefined.
  const [pick, setPick] = useState<string | undefined>(undefined);

  // Переключатель тот же, что на дашборде и в «Креаторах»: положение общее через localStorage.
  // Площадка режет оба списка сразу — и привязанных, и тех, кого можно привязать.
  const platform = usePlatformFilter();
  const platformFilter = platform.filter;

  const assignedAll = useMemo(
    () => (data ? data.creators.filter((c) => data.assigned.has(c.id)) : []),
    [data],
  );
  const freeAll = useMemo(
    () => (data ? data.creators.filter((c) => !data.assigned.has(c.id)) : []),
    [data],
  );
  const assignedList = useMemo(
    () => assignedAll.filter((c) => matchesPlatform(platformFilter, c.platform)),
    [assignedAll, platformFilter],
  );
  const free = useMemo(
    () => freeAll.filter((c) => matchesPlatform(platformFilter, c.platform)),
    [freeAll, platformFilter],
  );

  const displayName = name ?? manager?.display_name ?? "";

  async function saveName() {
    if (!manager) return;
    setSavingName(true);
    const res = await updateDisplayName(manager.user_id, displayName);
    setSavingName(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("manager.nameSaved"));
    setName(null);
    reload();
  }

  async function attach(creatorId: string) {
    const res = await assignManager(creatorId, id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setPick(undefined);
    reload();
  }

  async function detach(creatorId: string) {
    const res = await unassignManager(creatorId, id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    reload();
  }

  async function remove() {
    setDeleting(true);
    const res = await deleteManager(id);
    setDeleting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("manager.deleted"));
    router.replace("/managers/");
  }

  return (
    <Page
      title={manager ? profileName(manager) : t("manager.title")}
      subtitle={manager ? manager.login : undefined}
      actions={
        manager ? (
          <>
            <PlatformSwitch state={platform} />
            <PasswordDialog manager={manager} />
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon data-icon="inline-start" />
              {t("manager.deleteButton")}
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <PageError error={error} />
      ) : loading && !data ? (
        <PageSkeleton blocks={1} />
      ) : !manager ? (
        <p className="text-sm text-muted-foreground">{t("manager.notFound")}</p>
      ) : (
        <>
          {confirmDelete && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm">
                {t("manager.confirmDelete", { name: profileName(manager) })}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  {t("common.no")}
                </Button>
                <Button variant="destructive" size="sm" onClick={remove} disabled={deleting}>
                  {deleting ? t("common.deleting") : t("common.yesDelete")}
                </Button>
              </div>
            </div>
          )}

          <Panel className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
                <Label htmlFor="manager-name">{t("manager.nameLabel")}</Label>
                <Input
                  id="manager-name"
                  value={displayName}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={manager.login}
                />
              </div>
              <Button
                size="sm"
                onClick={saveName}
                disabled={savingName || name === null || name === manager.display_name}
              >
                {savingName ? t("common.saving") : t("common.save")}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("manager.loginPrefix")} <span className="font-mono">{manager.login}</span>{" "}
              {t("manager.loginSuffix")} <LocalTime iso={manager.created_at} mode="date" />.
            </p>
          </Panel>

          <Panel>
            <PanelHead
              title={t("manager.creatorsPanel")}
              subtitle={t("manager.attached", { n: fmtNum(assignedList.length) })}
            >
              <Select value={pick} onValueChange={(v) => void attach(v)}>
                <SelectTrigger size="sm" className="w-56">
                  <SelectValue placeholder={t("manager.attachPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {free.length === 0 ? (
                    <SelectItem value="none" disabled>
                      {freeAll.length === 0
                        ? t("manager.allAttached")
                        : t("manager.noFreeOnPlatform")}
                    </SelectItem>
                  ) : (
                    free.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.display_name || c.handle} · @{c.handle}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </PanelHead>

            {assignedList.length === 0 ? (
              <Empty>
                {assignedAll.length === 0
                  ? t("manager.emptyNone")
                  : t("manager.emptyPlatform")}
              </Empty>
            ) : (
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-muted-foreground">{t("table.creator")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("table.platform")}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignedList.map((c) => {
                    const cname = c.display_name || c.handle;
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <Link href={`/creator/?id=${c.id}`} className="flex items-center gap-2 hover:underline">
                            <Avatar src={c.avatar_url} name={cname} size={28} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{cname}</span>
                              <span className="block truncate text-xs text-muted-foreground">@{c.handle}</span>
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <PlatformChip platform={c.platform} />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => void detach(c.id)}
                          >
                            {t("manager.detach")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}

// Пароль ставит база функцией admin_set_password: старого админ не видит.
function PasswordDialog({ manager }: { manager: Profile }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v) {
      setFirst("");
      setSecond("");
      setError(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (first !== second) {
      setError(t("common.passwordsDiffer"));
      return;
    }
    setBusy(true);
    const res = await setManagerPassword(manager.user_id, first);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast.success(t("manager.passwordChanged"));
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRoundIcon data-icon="inline-start" />
          {t("manager.passwordButton")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("manager.passwordTitle", { name: profileName(manager) })}</DialogTitle>
            <DialogDescription>{t("manager.passwordDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pwd1">{t("manager.passwordFirst")}</Label>
            <Input
              id="pwd1"
              type="password"
              autoComplete="new-password"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pwd2">{t("manager.passwordSecond")}</Label>
            <Input
              id="pwd2"
              type="password"
              autoComplete="new-password"
              value={second}
              onChange={(e) => setSecond(e.target.value)}
              required
              minLength={8}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("manager.passwordSubmitting") : t("manager.passwordSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

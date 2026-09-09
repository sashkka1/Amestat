"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { LangSwitch } from "@/components/lang-switch";
import { logout } from "@/lib/api/auth";
import { useT } from "@/lib/i18n";
import { myProfile } from "@/lib/api/profiles";
import { ProfileProvider } from "@/lib/profile-context";
import type { Profile, Role } from "@/lib/types";

type State =
  | { kind: "checking" }
  | { kind: "ok"; profile: Profile }
  | { kind: "no-profile" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

// Сторож для всех страниц, кроме публичных (/login/, /register/, /connected/): сервера нет,
// поэтому вход проверяется в браузере. Без сессии — на /login/; вошёл, но строки в
// profiles нет — «Доступ не выдан»; роль не подходит странице — «Только для администратора».
export function AuthGate({ children, role }: { children: React.ReactNode; role?: Role }) {
  const router = useRouter();
  const t = useT();
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    let checkedFor: string | null = null;

    async function check(userId: string) {
      if (checkedFor === userId) return;
      checkedFor = userId;
      try {
        const profile = await myProfile(userId);
        if (!alive) return;
        if (!profile) setState({ kind: "no-profile" });
        else if (role && profile.role !== role) setState({ kind: "forbidden" });
        else setState({ kind: "ok", profile });
      } catch (e) {
        if (alive) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (data.session) void check(data.session.user.id);
      else router.replace("/login/");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      if (session) void check(session.user.id);
      else router.replace("/login/");
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router, role]);

  switch (state.kind) {
    case "checking":
      return <GateSkeleton />;
    case "ok":
      return <ProfileProvider value={state.profile}>{children}</ProfileProvider>;
    case "no-profile":
      return <Blocked title={t("auth.noProfileTitle")}>{t("auth.noProfileText")}</Blocked>;
    case "forbidden":
      return (
        <Blocked title={t("auth.forbiddenTitle")} home>
          {t("auth.forbiddenText")}
        </Blocked>
      );
    case "error":
      return <Blocked title={t("auth.errorTitle")}>{state.message}</Blocked>;
  }
}

function Blocked({ title, children, home }: { title: string; children: React.ReactNode; home?: boolean }) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function onLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
      router.replace("/login/");
    }
  }
  return (
    <main className="relative flex flex-1 items-center justify-center p-4">
      <LangSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 text-center shadow-sm">
        <h1 className="mb-2 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{children}</p>
        <div className="flex justify-center gap-2">
          {home && (
            <Button variant="outline" onClick={() => router.replace("/")}>
              {t("common.home")}
            </Button>
          )}
          <Button variant={home ? "ghost" : "default"} onClick={onLogout} disabled={busy}>
            {t("common.logout")}
          </Button>
        </div>
      </div>
    </main>
  );
}

function GateSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4" aria-busy="true">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";
import { LangSwitch } from "@/components/lang-switch";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/api/auth";
import { useT, type TKey } from "@/lib/i18n";
import { useProfile } from "@/lib/profile-context";
import { profileName } from "@/lib/api/profiles";
import { cn } from "@/lib/utils";

const ADMIN_NAV: { href: string; label: TKey }[] = [
  { href: "/", label: "nav.dashboard" },
  { href: "/creators/", label: "nav.creators" },
  { href: "/managers/", label: "nav.managers" },
  { href: "/archive/", label: "nav.archive" },
];

const MANAGER_NAV: { href: string; label: TKey }[] = [
  { href: "/", label: "nav.dashboard" },
  { href: "/creators/", label: "nav.creators" },
];

// Шапка со вкладками. Что видно, решает роль: архив и менеджеры — только админу.
// Переключатель языка стоит в правом верхнем углу, рядом с именем и выходом.
export function Header() {
  const router = useRouter();
  const pathname = usePathname();
  const profile = useProfile();
  const t = useT();
  const [busy, setBusy] = useState(false);

  const nav = profile.role === "admin" ? ADMIN_NAV : MANAGER_NAV;

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
    <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-[88rem] flex-wrap items-center gap-x-5 gap-y-2 px-5 py-2.5">
        <Link href="/" className="text-base font-semibold tracking-tight">
          Amestat
        </Link>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {nav.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {t(item.label)}
              </Link>
            );
          })}
        </nav>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {profileName(profile)}
          {` · ${profile.role === "admin" ? t("nav.admin") : t("nav.manager")}`}
        </span>
        <LangSwitch />
        <Button variant="ghost" size="sm" title={t("common.logout")} onClick={onLogout} disabled={busy}>
          <LogOutIcon data-icon="inline-start" />
          <span className="hidden sm:inline">{t("common.logout")}</span>
        </Button>
      </div>
    </header>
  );
}

// Карточка креатора живёт по /creator/, но относится ко вкладке «Креаторы».
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const p = pathname.endsWith("/") ? pathname : `${pathname}/`;
  if (href === "/") return p === "/";
  if (href === "/creators/") return p === "/creators/" || p === "/creator/";
  if (href === "/managers/") return p === "/managers/" || p === "/manager/";
  return p === href;
}

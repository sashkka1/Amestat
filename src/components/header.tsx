"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/api/auth";

export function Header({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
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
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Amestat
        </Link>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">{children}</div>
        <Button variant="ghost" size="sm" title="Выйти" onClick={onLogout} disabled={busy}>
          <LogOutIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Выйти</span>
        </Button>
      </div>
    </header>
  );
}

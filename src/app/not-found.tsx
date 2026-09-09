"use client";

import Link from "next/link";
import { LangSwitch } from "@/components/lang-switch";
import { useT } from "@/lib/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <LangSwitch className="absolute right-4 top-4" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("notFound.title")}</h1>
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        {t("notFound.toDashboard")}
      </Link>
    </main>
  );
}

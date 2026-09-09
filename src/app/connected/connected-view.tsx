"use client";

import Link from "next/link";
import { LangSwitch } from "@/components/lang-switch";
import { useT } from "@/lib/i18n";

// Тело публичной страницы возврата. Отдельным клиентским компонентом, потому что сама
// страница остаётся серверной: у неё свой `metadata`, а слова нужны на выбранном языке.
export function ConnectedView() {
  const t = useT();
  return (
    <main className="relative flex flex-1 items-center justify-center p-4">
      <LangSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">{t("connected.title")}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{t("connected.text")}</p>
        <Link
          href="/"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t("common.home")}
        </Link>
      </div>
    </main>
  );
}

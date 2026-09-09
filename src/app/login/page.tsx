"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LangSwitch } from "@/components/lang-switch";
import { useDocumentTitle, useT } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  useDocumentTitle(t("login.submit"));

  // Уже вошли — форма не нужна, сразу к списку.
  useEffect(() => {
    let alive = true;
    void createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (alive && data.session) router.replace("/");
      });
    return () => {
      alive = false;
    };
  }, [router]);

  return (
    <main className="relative flex flex-1 items-center justify-center p-4">
      <LangSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Amestat</h1>
        <p className="mb-6 text-sm text-muted-foreground">{t("login.subtitle")}</p>
        <LoginForm />
      </div>
    </main>
  );
}

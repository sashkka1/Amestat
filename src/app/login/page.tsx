"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  const router = useRouter();

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
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Amestat</h1>
        <p className="mb-6 text-sm text-muted-foreground">Вход для администратора и менеджеров</p>
        <LoginForm />
      </div>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";

// Сторож для всех страниц, кроме /login/: сервера нет, поэтому вход проверяется в браузере.
// Без сессии — на /login/; пока проверяем — скелет, чтобы не мигать содержимым.
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let alive = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (data.session) setReady(true);
      else router.replace("/login/");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      if (session) setReady(true);
      else router.replace("/login/");
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  if (!ready) return <GateSkeleton />;
  return <>{children}</>;
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

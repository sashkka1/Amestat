"use client";

import { Header } from "@/components/header";
import { Skeleton } from "@/components/ui/skeleton";

// Общая раскладка внутренних страниц: шапка со вкладками, строка заголовка, содержимое.
export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-[88rem] flex-1 flex-col gap-4 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </main>
    </>
  );
}

export function PageError({ error }: { error: string }) {
  return (
    <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      Не удалось прочитать базу: {error}
    </p>
  );
}

export function PageSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-24 w-full" />
      {Array.from({ length: blocks }).map((_, i) => (
        <Skeleton key={i} className="h-56 w-full" />
      ))}
    </div>
  );
}

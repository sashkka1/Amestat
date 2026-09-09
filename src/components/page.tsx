"use client";

import { Header } from "@/components/header";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Общая раскладка внутренних страниц: шапка со вкладками, строка заголовка, содержимое.
// Заголовок вкладки браузера ставится отсюда же: статика печатает его заранее по-английски,
// поэтому язык проставляется уже в браузере.
//
// title необязателен: карточка креатора обходится без заголовка над страницей (владелец,
// 2026-09-09) — имя там уже стоит в шапке карточки. Вкладке браузера имя всё равно нужно,
// и для этого случая есть docTitle: он живёт отдельно от видимого заголовка.
export function Page({
  title,
  docTitle,
  subtitle,
  actions,
  toolbar,
  children,
}: {
  title?: string;
  docTitle?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  // Слева в строке действий: полоса периода и прочее, что владелец хочет видеть в одну
  // строку с кнопкой «Обновить» (2026-09-09).
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  useDocumentTitle(docTitle ?? title ?? "");
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-[88rem] flex-1 flex-col gap-4 px-5 py-5">
        {(title || actions || toolbar) && (
          // Без заголовка кнопки остаются справа: прижимать их к левому краю строка не должна.
          <div className={cn("flex flex-wrap items-center gap-3", title || toolbar ? "justify-between" : "justify-end")}>
            {title && (
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
              </div>
            )}
            {!title && toolbar && <div className="flex min-w-0 flex-wrap items-center gap-2">{toolbar}</div>}
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </main>
    </>
  );
}

export function PageError({ error }: { error: string }) {
  const t = useT();
  return (
    <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {t("page.readError", { error })}
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

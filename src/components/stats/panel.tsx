import { cn } from "@/lib/utils";

// Белая карточка на сером фоне: одна рамка, радиус 12, тень-волосок.
export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("rounded-xl border bg-card shadow-sm", className)}>{children}</section>;
}

// Шапка карточки: заголовок слева, управление справа.
export function PanelHead({
  title,
  subtitle,
  children,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

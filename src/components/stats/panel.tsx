"use client";

import { Children, createContext, isValidElement, useContext } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useCollapsed } from "@/lib/collapsed";
import { cn } from "@/lib/utils";

// Белая карточка на сером фоне: одна рамка, радиус 12, тень-волосок.
//
// `min-w-0` здесь обязателен: карточка — элемент flex-колонки страницы, а у таких
// минимальная ширина по умолчанию равна ширине содержимого. Без него широкая таблица
// растягивает саму карточку за край окна и её обрезает, вместо того чтобы прокручиваться
// внутри (прокрутку даёт обёртка в `ui/table`). `overflow-hidden` держит углы скруглёнными.
//
// `collapseKey` — карточка сворачивается по щелчку в заголовок, ровно как панель «Ход
// обновления»: положение живёт в localStorage под этим ключом (`lib/collapsed.ts`).
// ⚠️ Сворачивание — только показ: данные грузятся как раньше, свёрнутая карточка ничего
// не отменяет и ничего не откладывает.
//
// `defaultCollapsed` — карточка встаёт свёрнутой, пока владелец её не раскрывал. Так стоит
// матрица перекрёстности на дашборде: заголовок виден, содержимое — по щелчку.
export function Panel({
  className,
  collapseKey,
  defaultCollapsed = false,
  children,
}: {
  className?: string;
  collapseKey?: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  if (collapseKey === undefined) return <PanelBox className={className}>{children}</PanelBox>;
  return (
    <CollapsiblePanel
      collapseKey={collapseKey}
      defaultCollapsed={defaultCollapsed}
      className={className}
    >
      {children}
    </CollapsiblePanel>
  );
}

function PanelBox({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm", className)}>
      {children}
    </section>
  );
}

type Collapse = { open: boolean; toggle: () => void };

// Заголовок узнаёт про сворачивание отсюда: шапку рисует `PanelHead`, а состоянием владеет
// карточка — иначе каждый вызов PanelHead пришлось бы снабжать тем же ключом второй раз.
const CollapseCtx = createContext<Collapse | null>(null);

// Свёрнутая карточка показывает только шапку. Отбираем её по типу элемента: у всех карточек
// `PanelHead` стоит первым ребёнком, а всё остальное — содержимое.
function CollapsiblePanel({
  collapseKey,
  defaultCollapsed,
  className,
  children,
}: {
  collapseKey: string;
  defaultCollapsed: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const collapse = useCollapsed(collapseKey, defaultCollapsed);
  const kids = Children.toArray(children);
  const heads = kids.filter((node) => isValidElement(node) && node.type === PanelHead);
  const body = kids.filter((node) => !(isValidElement(node) && node.type === PanelHead));
  return (
    <CollapseCtx.Provider value={collapse}>
      <PanelBox className={className}>
        {heads}
        {collapse.open && body}
      </PanelBox>
    </CollapseCtx.Provider>
  );
}

// Шапка карточки: заголовок слева, управление справа. У сворачиваемой карточки заголовок —
// кнопка с шевроном (тот же вид, что у панели «Ход обновления»), а управление прячется
// вместе с содержимым: у свёрнутого блока видны только название и подпись.
//
// ⚠️ Кнопкой становится именно левая половина, а не вся строка: справа живут поля поиска и
// переключатели, а вложить их внутрь `<button>` нельзя.
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
  const collapse = useContext(CollapseCtx);
  const text = (
    <div className="min-w-0">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3", className)}>
      {collapse ? (
        <button
          type="button"
          onClick={collapse.toggle}
          aria-expanded={collapse.open}
          className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !collapse.open && "-rotate-90",
            )}
          />
          {text}
        </button>
      ) : (
        text
      )}
      {children && (!collapse || collapse.open) && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

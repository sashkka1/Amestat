import { PlatformIcon } from "@/components/platform";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

// 🔴 Единственная подпись креатора на сайте (владелец, 2026-09-09): иконка площадки, имя и
// ник серым — одной компактной строкой вместо прежней пары в две строки. Имя не убирается
// нигде: убрана только вторая строка под ним.
//
// Компонент один нарочно: списки, таблицы и выпадающие списки обязаны называть креатора
// одинаково, иначе через месяц половина мест снова покажет что-нибудь своё.
//
// ⚠️ Иконка нужна в первую очередь выпадающим спискам (владелец, 2026-09-09): одинаковый ник
// на TikTok и в Instagram иначе не различить, а колонки площадки в списке нет.
export function CreatorLabel({
  platform,
  name,
  handle,
  className,
}: {
  platform: Platform;
  // Имя креатора (`display_name`); пусто — остаётся один ник.
  name?: string | null;
  handle: string;
  className?: string;
}) {
  const shown = name?.trim() ?? "";
  // Имя у большинства креаторов и есть ник (при заведении оно им и заполняется) — тогда
  // «julia.snkvch @julia.snkvch» было бы одним и тем же словом дважды.
  const same = shown.replace(/^@/, "").toLowerCase() === handle.toLowerCase();
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <PlatformIcon platform={platform} className="shrink-0" />
      {shown && <span className="truncate">{shown}</span>}
      {(!shown || !same) && (
        <span className="truncate text-xs text-muted-foreground">@{handle}</span>
      )}
    </span>
  );
}

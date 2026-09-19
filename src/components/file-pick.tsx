"use client";

import { useRef } from "react";
import { PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// 🔴 Единственное поле выбора файла на сайте (владелец, 2026-09-19: в окне добавления креатора
// стояло «Файл не выбран» — «такого не должно быть, только en на сайте»).
//
// Причина беды: у голого `<input type="file">` кнопку и надпись рисует САМ БРАУЗЕР, и пишет он
// их на своём языке — у владельца Opera по-русски. Словарь сайта до этого текста не достаёт
// ничем: ни переводом, ни стилями. Поэтому нативное поле спрятано (`sr-only`, чтобы остаться
// доступным с клавиатуры и для чтения с экрана), а видны наша кнопка и наша подпись.
//
// ⚠️ Компонент один нарочно, как `creator-label.tsx` и `gone-mark.tsx`: полей выбора файла на
// сайте три — аватар при заведении креатора, аватар при правке и документ выплаты. Заведи
// второе такое место голым `input`, и русская надпись вернётся именно там.
export function FilePick({
  id,
  file,
  onPick,
  accept,
  className,
}: {
  id: string;
  file: File | null;
  onPick: (file: File | null) => void;
  accept?: string;
  className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <input
        ref={ref}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => ref.current?.click()}>
        <PaperclipIcon data-icon="inline-start" />
        {t("common.chooseFile")}
      </Button>
      <span className={cn("min-w-0 flex-1 truncate text-xs", file ? "" : "text-muted-foreground")}>
        {file ? file.name : t("common.noFile")}
      </span>
      {file && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={t("common.clearFile")}
          aria-label={t("common.clearFile")}
          onClick={() => {
            // Чистим и само поле: иначе повторный выбор того же файла не даст события change.
            if (ref.current) ref.current.value = "";
            onPick(null);
          }}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

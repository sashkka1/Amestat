"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { LANGS, useLang, useT, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Переключатель языка в правом верхнем углу (владелец, 2026-09-09) — три коротких блока
// RU / EN / PT. Вид тот же, что у переключателя площадки (`components/platform-switch.tsx`):
// выбранный — `secondary`, остальные — `outline`.
export function LangSwitch({ className }: { className?: string }) {
  const t = useT();
  const { lang, setLang } = useLang();

  return (
    <div
      className={cn("flex items-center gap-1", className)}
      role="group"
      aria-label={t("lang.label")}
    >
      {LANGS.map((key) => {
        const on = lang === key;
        return (
          <Button
            key={key}
            type="button"
            size="xs"
            variant={on ? "secondary" : "outline"}
            aria-pressed={on}
            onClick={() => setLang(key)}
          >
            {t(`lang.${key}` as const)}
          </Button>
        );
      })}
    </div>
  );
}

// `<html lang>` статика печатает русским: язык проставляется уже в браузере, как и заголовок
// вкладки. Отдельным компонентом, потому что сама раскладка — серверная.
const HTML_LANG: Record<Lang, string> = { ru: "ru", en: "en", "pt-BR": "pt-BR" };

export function LangHtml() {
  const { lang } = useLang();
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
  }, [lang]);
  return null;
}

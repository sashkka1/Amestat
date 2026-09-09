import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { LangHtml } from "@/components/lang-switch";
import { Toaster } from "@/components/ui/sonner";
import { en } from "@/lib/i18n/en";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// ⚠️ `metadata` и `<html lang>` статика печатает при сборке, когда языка ещё нет: там всегда
// английский, основной язык сайта. Выбранный язык проставляет `LangHtml` уже в браузере, а
// заголовок вкладки — `useDocumentTitle` в `components/page.tsx` и на отдельных страницах.
export const metadata: Metadata = {
  title: en.meta.title,
  description: en.meta.description,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <LangHtml />
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}

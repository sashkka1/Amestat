// Браузер для обхода. Две вещи, которые выяснены пробами 2026-09-08 и не обсуждаются:
//
//  1. Запускать надо ВЕРСИОННЫЙ opera.exe (`…\Programs\Opera\<версия>\opera.exe`).
//     Корневой `…\Programs\Opera\opera.exe` — лаунчер: он стартует настоящий процесс и
//     завершается, а Playwright считает браузер упавшим.
//  2. TikTok отдаёт список видео только в СВЕЖЕМ пустом профиле. Второй креатор в том же
//     профиле и любой повторный запуск получают ответы 200 с пустым телом и ноль видео.
//     Поэтому профиль одноразовый: свой временный каталог на каждого креатора, после —
//     удаляется. Вход в TikTok не нужен, страницы публичные.

import { chromium } from "playwright-core";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

/** Самый свежий версионный opera.exe или null, если Opera не установлена. */
export function findOpera() {
  const root = resolve(process.env.LOCALAPPDATA ?? "", "Programs", "Opera");
  if (!process.env.LOCALAPPDATA || !existsSync(root)) return null;
  const versions = readdirSync(root)
    .filter((name) => /^\d+(\.\d+)+$/.test(name) && existsSync(join(root, name, "opera.exe")))
    // Номер версии — не строка: 123.0 старше 99.0, лексикографическая сортировка врёт.
    .sort((a, b) => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return d;
      }
      return 0;
    });
  const latest = versions.at(-1);
  return latest ? join(root, latest, "opera.exe") : null;
}

/**
 * Что запускать. `choice` — значение AMESTAT_BROWSER:
 *   пусто          → Opera, если установлена, иначе Chrome по каналу;
 *   `opera`        → только Opera (нет — ошибка);
 *   `chrome`       → Chrome по каналу;
 *   полный путь    → этот exe.
 * Отдаёт `{ kind, executablePath, describe }`.
 */
export function resolveBrowser(choice = "") {
  const want = choice.trim();
  if (!want) {
    const opera = findOpera();
    return opera
      ? { kind: "opera", executablePath: opera, describe: `Opera ${opera}` }
      : { kind: "chrome", executablePath: null, describe: "Chrome (channel chrome)" };
  }
  if (want.toLowerCase() === "opera") {
    const opera = findOpera();
    if (!opera) throw new Error("AMESTAT_BROWSER=opera, но Opera не найдена в %LOCALAPPDATA%\\Programs\\Opera");
    return { kind: "opera", executablePath: opera, describe: `Opera ${opera}` };
  }
  if (want.toLowerCase() === "chrome") {
    return { kind: "chrome", executablePath: null, describe: "Chrome (channel chrome)" };
  }
  if (!existsSync(want)) throw new Error(`AMESTAT_BROWSER указывает на несуществующий файл: ${want}`);
  return { kind: "custom", executablePath: want, describe: want };
}

/**
 * Свежий одноразовый профиль и запущенный в нём браузер.
 * Отдаёт `{ ctx, cleanup, profileDir, describe }`; `cleanup()` закрывает браузер и стирает профиль.
 */
export async function launchFresh(choice = "", { headless = true } = {}) {
  const browser = resolveBrowser(choice);
  const profileDir = mkdtempSync(join(tmpdir(), "amestat-"));
  let ctx = null;
  const cleanup = async () => {
    try {
      if (ctx) await ctx.close();
    } catch {
      // Браузер мог уже упасть сам — профиль всё равно надо убрать.
    }
    rmSync(profileDir, { recursive: true, force: true });
  };
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      ...(browser.executablePath ? { executablePath: browser.executablePath } : { channel: "chrome" }),
      headless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  } catch (e) {
    rmSync(profileDir, { recursive: true, force: true });
    throw new Error(`браузер не запустился (${browser.describe}): ${String(e.message ?? e).split("\n")[0]}`);
  }
  return { ctx, cleanup, profileDir, describe: browser.describe };
}

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
import { execFile } from "node:child_process";
import { notice } from "./notices.mjs";
import { existsSync, readdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/** Постоянный профиль с сессиями фейковых аккаунтов. ⚠️ Не стирать: в нём живёт вход. */
export const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "profile-opera");

const LAUNCH_TIMEOUT_MS = 60_000;  // свой срок на запуск: у Playwright по умолчанию три минуты
const LAUNCH_RETRY_MS = 10_000;    // столько ждём перед второй попыткой
const CLOSE_WAIT_MS = 5_000;       // столько ждём, пока браузер уйдёт сам, прежде чем добивать

// Страница видео TikTok тянет десятки сторонних фреймов: обход #38 (слот 17:00, 2026-09-08)
// держал 61 процесс Opera и 5,4 ГБ памяти, из них 56 renderer'ов. Отсюда эти два ключа:
// один процесс на сайт и потолок renderer'ов. ⚠️ Ключи общие для обоих запусков — и свежего
// профиля TikTok, и постоянного `profile-opera`.
const LEAN_ARGS = ["--process-per-site", "--renderer-process-limit=8"];

// Куда уводится окно на шаге комментариев TikTok: далеко за левый верхний угол экрана.
// Владелец, 2026-09-08: «каждая проверка не должна открывать мне окно Opera во всю ширину —
// пусть запускается тихо». Размер тоже задан: окно во всю ширину владелец видит краем даже
// уведённым, если оно шире экрана.
const OFFSCREEN = { left: -2400, top: -2400, width: 1100, height: 800 };

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
 * Заставить профиль забыть «развёрнуто на весь экран».
 *
 * ⚠️ Зачем: Opera помнит расположение окна в `profile-opera/Default/Preferences`
 * (`browser.window_placement.maximized`), и запомненное «развёрнуто» ПЕРЕБИВАЕТ
 * `--window-position`: окно раскрывается поверх работы владельца. Файл Opera переписывает при
 * выходе, поэтому правится он ПЕРЕД КАЖДЫМ запуском, а не один раз.
 * `work_area_*` не трогаем — их Opera считает сама.
 * Отдаёт null, если всё хорошо, иначе текст беды (обход из-за этого не валится).
 */
function forceOffscreenPlacement() {
  const file = resolve(PROFILE_DIR, "Default", "Preferences");
  if (!existsSync(file)) return "в профиле нет Default/Preferences — расположение окна не поправить";
  let json = null;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `Default/Preferences не разобрался: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  try {
    json.browser = json.browser ?? {};
    const was = json.browser.window_placement ?? {};
    // ⚠️ Диалект файла бывает разный: у этого профиля размеры лежат в `width`/`height`,
    // у классического Chromium — в `right`/`bottom`. Пишем в том, который уже есть, чтобы
    // Opera прочла своё; нет ни того ни другого — кладём `width`/`height`.
    const size = "right" in was || "bottom" in was
      ? { right: OFFSCREEN.left + OFFSCREEN.width, bottom: OFFSCREEN.top + OFFSCREEN.height }
      : { width: OFFSCREEN.width, height: OFFSCREEN.height };
    json.browser.window_placement = { ...was, ...size, maximized: false, left: OFFSCREEN.left, top: OFFSCREEN.top };
    writeFileSync(file, JSON.stringify(json), "utf8");
  } catch (e) {
    return `Default/Preferences не записался: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  return null;
}

/**
 * Отучить профиль восстанавливать вкладки прошлого запуска.
 *
 * ⚠️ Зачем: копия профиля снята с Opera владельца, а у него включено «продолжить с того места»
 * — при каждом запуске всплывал весь его хвост вкладок (Instagram, TikTok, пустые), а к нему
 * добавлялись вкладки прерванных обходов; в обходе #38 (2026-09-08) браузер начал их подгружать
 * и раздулся до 57 renderer-процессов. Лечение двойное: в `Preferences` стартовая страница
 * «пустая» и «вышли чисто», а файлы сохранённой сессии в `Default/Sessions` стираются. Opera
 * переписывает и то и другое при выходе, поэтому — перед КАЖДЫМ запуском, для любого режима.
 * Отдаёт null, если всё хорошо, иначе текст беды (обход из-за этого не валится).
 */
function forgetSession() {
  const prefs = resolve(PROFILE_DIR, "Default", "Preferences");
  if (existsSync(prefs)) {
    try {
      const json = JSON.parse(readFileSync(prefs, "utf8"));
      json.session = { ...(json.session ?? {}), restore_on_startup: 5, startup_urls: [] };
      json.profile = { ...(json.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
      writeFileSync(prefs, JSON.stringify(json), "utf8");
    } catch (e) {
      return `Default/Preferences не поправился: ${String(e?.message ?? e).split("\n")[0]}`;
    }
  }
  const sessions = resolve(PROFILE_DIR, "Default", "Sessions");
  if (existsSync(sessions)) {
    try {
      for (const name of readdirSync(sessions)) rmSync(join(sessions, name), { force: true });
    } catch (e) {
      return `Default/Sessions не стёрлись: ${String(e?.message ?? e).split("\n")[0]}`;
    }
  }
  return null;
}

/**
 * Увести окно этой страницы за край экрана средствами самого браузера.
 * ⚠️ Именно `normal` с координатами, а НЕ `minimized`: у свёрнутого окна `visibilityState`
 * становится `hidden`, и TikTok перестаёт подгружать список — ровно как в headless.
 * Отдаёт границы окна или null (в скрытом браузере окна нет вовсе, и это не беда).
 */
export async function hideWindow(ctx, page, { log } = {}) {
  let cdp = null;
  try {
    cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", ...OFFSCREEN } });
    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
    log?.(`    окно уведено: left=${bounds.left}, top=${bounds.top}, ${bounds.width}×${bounds.height}, state=${bounds.windowState}`);
    return bounds;
  } catch {
    // Скрытый браузер или CDP не дался — на сбор это не влияет.
    return null;
  } finally {
    try {
      await cdp?.detach();
    } catch {
      // Сессия могла закрыться вместе со страницей.
    }
  }
}

/** Запуск команды Windows без окна. Отдаёт stdout (пустую строку, если не вышло). */
function run(cmd, args) {
  return new Promise((done) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8e6 }, (err, stdout) => done(err ? "" : String(stdout ?? "")));
  });
}

/**
 * Дождаться, пока браузер уйдёт сам, и добить, если не ушёл.
 * ⚠️ Зачем: `ctx.close()` иногда возвращается, а процесс Opera остаётся жить с полусотней
 * renderer'ов и гигабайтами памяти. Ждём `CLOSE_WAIT_MS` и убиваем деревом.
 * Отдаёт true, если пришлось добивать.
 */
async function killIfAlive(ctx) {
  let proc = null;
  try {
    proc = ctx.browser()?.process() ?? null;
  } catch {
    // Персистентный контекст мог не отдать браузер — тогда добить некого, и это не беда.
  }
  if (!proc || proc.exitCode !== null) return false;
  const until = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < until && proc.exitCode === null) await new Promise((r) => setTimeout(r, 250));
  if (proc.exitCode !== null) return false;
  // На Windows одного `kill()` мало: renderer'ы — отдельные процессы, нужен весь куст.
  if (process.platform === "win32" && proc.pid) await run("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
  else {
    try {
      proc.kill();
    } catch {
      // Процесс мог уйти между проверкой и сигналом.
    }
  }
  return true;
}

// Похоже на видео или шрифт по самому адресу. Нужно вот зачем: перехват ставится по адресу,
// а `resourceType` виден только внутри обработчика — см. `trimTraffic`.
const HEAVY_URL = /\.(mp4|m4s|m3u8|ts|webm|mov|avi|mp3|m4a|aac|woff2?|ttf|otf|eot)(\?|#|$)/i;

/**
 * Отсечь у страниц всё лишнее: чужие хосты, видео и шрифты. Ставится на КОНТЕКСТ, значит
 * действует на все его вкладки.
 *
 * ⚠️ Перехват вешается НЕ на `**\/*`, а на проверку адреса, и это главное здесь: запросы к самой
 * площадке (в том числе `comment/list`) через перехват не проходят вовсе. Причина — та же, что в
 * шапке `comments-tiktok.mjs`: тронутый запрос сжигает одноразовый msToken, и вместо
 * комментариев приезжает пустое тело и капча. Отклонение — `route.abort()`, переигрывания
 * (`route.fetch()`) нет нигде.
 *
 * Картинки остаются: памяти они почти не едят, а без них площадки иногда рисуют другую разметку.
 *
 * `allow` — куски имён хостов, которые пропускаем («tiktok», «cdninstagram»…).
 * Отдаёт `count()` — `{ aborted, passed }` на момент вызова.
 */
export async function trimTraffic(ctx, allow, { log } = {}) {
  let aborted = 0, passed = 0;
  const hostOf = (link) => {
    try {
      return new URL(link).hostname.toLowerCase();
    } catch {
      return "";   // data:, blob: и прочее — не наше дело
    }
  };
  const ours = (host) => allow.some((part) => host.includes(part));
  // Трогаем только то, что МОЖЕМ отклонить: чужой хост или адрес, похожий на видео/шрифт.
  // ⚠️ Сюда Playwright передаёт объект URL, а не строку, — приводим сами.
  const suspicious = (link) => {
    const s = String(link);
    const host = hostOf(s);
    if (!host) return false;
    return !ours(host) || HEAVY_URL.test(s);
  };
  await ctx.route(suspicious, (route) => {
    const type = route.request().resourceType();
    const host = hostOf(route.request().url());
    if (!ours(host) || type === "media" || type === "font" || HEAVY_URL.test(route.request().url())) {
      aborted++;
      route.abort().catch(() => {});
      return;
    }
    passed++;
    route.continue().catch(() => {});
  });
  log?.(`  лишнее в браузер не пускаем: только ${allow.join(", ")}, без видео и шрифтов`);
  return () => ({ aborted, passed });
}

/**
 * Остатки прошлых обходов: окна Opera на постоянном профиле `profile-opera` или на временных
 * профилях `amestat-…`. Свои окна владельца не трогаются вовсе — отбор идёт по нашему
 * `--user-data-dir` в командной строке процесса.
 * Отдаёт `{ killed, pids }`; на не-Windows не делает ничего.
 */
export async function killLeftoverBrowsers() {
  if (process.platform !== "win32") return { killed: 0, pids: [] };
  const out = await run("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='opera.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  ]);
  let rows = [];
  try {
    const json = JSON.parse(out || "[]");
    rows = Array.isArray(json) ? json : [json];
  } catch {
    // Ничего не нашлось или PowerShell промолчал — добивать нечего.
    return { killed: 0, pids: [] };
  }
  const pids = [];
  for (const row of rows) {
    const line = String(row?.CommandLine ?? "");
    const pid = Number(row?.ProcessId);
    if (!Number.isFinite(pid)) continue;
    if (!line.includes("profile-opera") && !/[\\/]amestat-/.test(line)) continue;
    pids.push(pid);
  }
  for (const pid of pids) await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  return { killed: pids.length, pids };
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
    for (const page of ctx?.pages() ?? []) {
      try {
        await page.close();
      } catch {
        // Вкладка могла закрыться сама вместе с браузером.
      }
    }
    try {
      if (ctx) await ctx.close();
    } catch {
      // Браузер мог уже упасть сам — профиль всё равно надо убрать.
    }
    // Не ушёл сам — добиваем: иначе временный профиль не сотрётся, а процессы останутся висеть.
    if (ctx && await killIfAlive(ctx)) notice("browser", "браузер не закрылся сам — пришлось добить (свежий профиль)");
    rmSync(profileDir, { recursive: true, force: true });
  };
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      ...(browser.executablePath ? { executablePath: browser.executablePath } : { channel: "chrome" }),
      headless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", ...LEAN_ARGS],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  } catch (e) {
    rmSync(profileDir, { recursive: true, force: true });
    const text = String(e.message ?? e).split("\n")[0];
    notice("browser", `свежий профиль не поднялся: ${text}`);
    throw new Error(`браузер не запустился (${browser.describe}): ${text}`);
  }
  return { ctx, cleanup, profileDir, describe: browser.describe };
}

/**
 * Браузер на ПОСТОЯННОМ профиле `profile-opera` — том, где вошли фейковые аккаунты.
 * Им ходят за комментариями: TikTok их гостю не отдаёт вовсе.
 *
 * ⚠️ `headless: false` — не прихоть. Комментарии TikTok в скрытом окне приходят пустым телом,
 * а следом показывается капча-пазл (проба 2026-09-08); с настоящим окном всё отдаётся сразу.
 * Чтобы окно не лезло владельцу под руку, оно уводится далеко за край экрана.
 *
 * ⚠️ Профиль один на всю машину: пока браузер открыт, второй процесс на этой папке не встанет.
 * Отсюда очередь обходов в `sync.mjs`. Стирать папку нельзя — потеряется вход.
 *
 * ⚠️ Запуск делается ДВАЖДЫ. Сразу после того, как закрылся предыдущий браузер (у TikTok это
 * одноразовый профиль со списком видео), Opera поднимается через раз: процесс стартует, пишет
 * в профиль и виснет, не отдав канал управления, — 2026-09-08 это стоило целого шага
 * комментариев. Ждать по три минуты незачем: свой срок в минуту, пауза и вторая попытка.
 * Отдаёт `{ ctx, cleanup, describe }`; `cleanup()` закрывает браузер, профиль НЕ трогает.
 */
export async function launchProfile(choice = "", { headless = true, log } = {}) {
  const browser = resolveBrowser(choice);
  if (!existsSync(PROFILE_DIR)) {
    throw new Error(`нет копии профиля Opera (${PROFILE_DIR}) — сними её с входом фейковых аккаунтов`);
  }
  // Настоящее окно — только на шаге комментариев TikTok, и оно не должно мелькать у владельца:
  // сначала отучаем профиль разворачиваться, потом задаём место и размер ключами, а после
  // запуска окно ещё и уводится через CDP (`hideWindow`).
  if (!headless) {
    const bad = forceOffscreenPlacement();
    if (bad) notice("browser", `окно может открыться поверх работы: ${bad}`);
  }
  // Хвост вкладок прошлых запусков не восстанавливать — ни в окне, ни в скрытом режиме.
  const stale = forgetSession();
  if (stale) notice("browser", `профиль может восстановить старые вкладки: ${stale}`);
  const options = {
    ...(browser.executablePath ? { executablePath: browser.executablePath } : { channel: "chrome" }),
    headless,
    timeout: LAUNCH_TIMEOUT_MS,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      ...LEAN_ARGS,
      ...(headless ? [] : [`--window-position=${OFFSCREEN.left},${OFFSCREEN.top}`, `--window-size=${OFFSCREEN.width},${OFFSCREEN.height}`]),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  let ctx = null, first = "";
  for (let attempt = 1; attempt <= 2 && ctx === null; attempt++) {
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, options);
    } catch (e) {
      const text = String(e?.message ?? e).split("\n")[0];
      if (attempt === 2) {
        notice("browser", `браузер не запустился дважды: ${first}; потом ${text}`);
        throw new Error(`браузер не запустился дважды (${browser.describe}): ${first}; потом ${text}`);
      }
      first = text;
      notice("browser", `браузер не встал с первого раза, пробую ещё: ${text}`);
      await new Promise((r) => setTimeout(r, LAUNCH_RETRY_MS));
    }
  }
  // Если вкладки всё же восстановились (Opera не послушала Preferences) — закрываем всё,
  // кроме первой: каждая лишняя вкладка — свой renderer и своя память.
  const restored = ctx.pages().slice(1);
  if (restored.length > 0) {
    for (const page of restored) {
      try {
        await page.close();
      } catch {
        // Уже закрыта.
      }
    }
    log?.(`  закрыто восстановленных вкладок: ${restored.length}`);
    notice("browser", `профиль восстановил ${restored.length} старых вкладок — закрыты`);
  }
  // Первая вкладка у постоянного профиля открывается сама — уводим окно сразу, не дожидаясь,
  // пока сборщик откроет свою.
  if (!headless) {
    const first = ctx.pages()[0] ?? null;
    if (first) await hideWindow(ctx, first, { log });
  }

  const cleanup = async () => {
    // Вкладки закрываем сами: постоянный профиль помнит сессию, и незакрытая вкладка
    // всплывёт при следующем запуске (владелец, 2026-09-08: «закрывай их, чтобы меньше
    // жрало памяти и не захламлялись вкладки»).
    for (const page of ctx.pages()) {
      try {
        await page.close();
      } catch {
        // Вкладка могла закрыться сама вместе с браузером.
      }
    }
    try {
      await ctx.close();
    } catch {
      // Браузер мог упасть сам. ⚠️ Профиль НЕ стираем: в нём вход фейковых аккаунтов.
    }
    if (await killIfAlive(ctx)) notice("browser", "браузер не закрылся сам — пришлось добить (profile-opera)");
  };
  return { ctx, cleanup, describe: browser.describe };
}

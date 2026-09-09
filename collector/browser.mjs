// Браузер для обхода. Две вещи, которые выяснены пробами 2026-09-08 и не обсуждаются:
//
//  1. Запускать надо ВЕРСИОННЫЙ opera.exe (`…\Programs\Opera\<версия>\opera.exe`).
//     Корневой `…\Programs\Opera\opera.exe` — лаунчер: он стартует настоящий процесс и
//     завершается, а Playwright считает браузер упавшим.
//  2. TikTok отдаёт список видео только в СВЕЖЕМ пустом профиле. Второй креатор в том же
//     профиле и любой повторный запуск получают ответы 200 с пустым телом и ноль видео.
//     Поэтому профиль одноразовый: свой временный каталог на каждого креатора, после —
//     удаляется. Вход в TikTok не нужен, страницы публичные.
//  3а. Прокси (2026-09-09) передаётся Playwright полем `proxy`, а не ключом `--proxy-server`:
//     логин и пароль идут отдельными полями и в командную строку процесса не попадают. Прочее
//     от прокси не зависит: `trimTraffic` работает поверх (`route.abort()`/`continue()` — это
//     решение браузера о своём же запросе), `--process-per-site` и потолок renderer'ов тоже.
//  3. Постоянных профилей с входом фейка ДВА и это не дубль по недосмотру: на одной папке
//     живёт ровно один процесс браузера, а обход идёт двумя полосами разом (`sync.mjs`), и
//     профиль нужен обеим — Instagram'у и комментариям TikTok. `profile-tiktok` заводится
//     копией `profile-opera` сам, при первом запуске (`ensureProfileCopy`).

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { notice } from "./notices.mjs";
import { existsSync, readdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, renameSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Постоянный профиль с сессиями фейковых аккаунтов. ⚠️ Не стирать: в нём живёт вход. */
export const PROFILE_OPERA = resolve(HERE, "profile-opera");
/**
 * Вторая копия того же профиля — под полосу TikTok (`sync.mjs` водит две полосы разом).
 * ⚠️ Зачем копия: на одной папке профиля живёт РОВНО ОДИН процесс браузера, а профиль с
 * сессией фейка нужен обеим полосам сразу — Instagram'у (лента и комментарии) и комментариям
 * TikTok. Заводится сама из `profile-opera` при первом запуске (`ensureProfileCopy`).
 * ⚠️ Cookies в копиях дальше живут своей жизнью: сессия может истечь в одной и остаться в
 * другой, поэтому замечания про вход называют профиль.
 */
export const PROFILE_TIKTOK = resolve(HERE, "profile-tiktok");
/** Прежнее имя постоянного профиля: осталось, чтобы не переписывать всех, кто его звал. */
export const PROFILE_DIR = PROFILE_OPERA;

// Чего в копию профиля не тащим: кэши и сохранённая сессия вкладок. Всё это либо весит
// гигабайты, либо восстанавливает чужие вкладки — а вход живёт в Cookies и Local State.
const COPY_SKIP = new Set(["Cache", "Code Cache", "GPUCache", "Service Worker", "Sessions"]);

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

/**
 * Прокси для запуска браузера — как его понимает Playwright.
 * `address` — адрес пула (`proxies.mjs`): `{ id, label, server, username, password }`. Домашний
 * адрес прокси не имеет вовсе (`server` пуст) — тогда здесь пусто и браузер идёт как раньше.
 *
 * ⚠️ Ключ `--proxy-server` в аргументах Chromium НЕ НУЖЕН: Playwright передаёт адрес сам, а
 * логин и пароль — отдельными полями (только так они не попадут ни в командную строку процесса,
 * ни в логи). Ключ рядом с `proxy` дал бы два разных источника правды.
 * 🔴 Логин и пароль отсюда никуда больше не уходят: в лог пишется только `label`.
 */
function proxyOption(address) {
  if (!address?.server) return {};
  return {
    proxy: {
      server: address.server,
      ...(address.username ? { username: address.username } : {}),
      ...(address.password ? { password: address.password } : {}),
    },
  };
}

/** Подпись адреса для лога: «домашний» или «прокси #2 host:port». Без учётных данных. */
export function addressLabel(address) {
  return address?.label ?? "домашний";
}

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
 * Вторая копия постоянного профиля, если её ещё нет. Отдаёт `{ copied, from, to }`.
 *
 * ⚠️ Копируется во ВРЕМЕННУЮ папку рядом и переименовывается в конце: оборванное копирование
 * (браузер держит файл, кончилось место) иначе оставило бы полупустую папку, которую следующий
 * запуск принял бы за готовый профиль и молча пошёл бы в неё без входа.
 * Кэши и сохранённые сессии не копируются вовсе (`COPY_SKIP`).
 */
export function ensureProfileCopy(to = PROFILE_TIKTOK, from = PROFILE_OPERA) {
  if (existsSync(to)) return { copied: false, from, to };
  if (!existsSync(from)) throw new Error(`нет копии профиля Opera (${from}) — с неё нечего копировать`);
  const tmp = `${to}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(from, tmp, { recursive: true, filter: (path) => !COPY_SKIP.has(basename(path)) });
    renameSync(tmp, to);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`вторая копия профиля не завелась (${to}): ${String(e?.message ?? e).split("\n")[0]}`);
  }
  return { copied: true, from, to };
}

/**
 * Заставить профиль забыть «развёрнуто на весь экран».
 *
 * ⚠️ Зачем: Opera помнит расположение окна в `profile-opera/Default/Preferences`
 * (`browser.window_placement.maximized`), и запомненное «развёрнуто» ПЕРЕБИВАЕТ
 * `--window-position`: окно раскрывается поверх работы владельца. Файл Opera переписывает при
 * выходе, поэтому правится он ПЕРЕД КАЖДЫМ запуском, а не один раз.
 * `work_area_*` не трогаем — их Opera считает сама.
 * ⚠️ Папка приходит параметром: копий постоянного профиля две (`profile-opera` и
 * `profile-tiktok`), и править надо ту, которую сейчас запускают.
 * Отдаёт null, если всё хорошо, иначе текст беды (обход из-за этого не валится).
 */
function forceOffscreenPlacement(dir) {
  const file = resolve(dir, "Default", "Preferences");
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
function forgetSession(dir) {
  const prefs = resolve(dir, "Default", "Preferences");
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
  const sessions = resolve(dir, "Default", "Sessions");
  if (existsSync(sessions)) {
    try {
      for (const name of readdirSync(sessions)) rmSync(join(sessions, name), { force: true });
    } catch (e) {
      return `Default/Sessions не стёрлись: ${String(e?.message ?? e).split("\n")[0]}`;
    }
  }
  return null;
}

// Окна, уже уведённые за край, по контексту браузера (см. `hideWindow`).
const HIDDEN = new WeakMap();

/**
 * Сторож окон: даёт владельцу вернуть уведённое окно на экран кликом по значку Opera в панели
 * задач (владелец, 2026-09-08: «дай мне разрешение, чтобы я мог сам их открыть»). Сам скрипт —
 * `show-window.ps1`; он один на систему и живёт, пока жив этот процесс. Поднимается лениво
 * перед первым настоящим окном; не поднялся — обход не страдает, только замечание.
 */
let watchStarted = false;
function ensureWindowWatch() {
  if (watchStarted) return;
  watchStarted = true;
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "show-window.ps1");
  try {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Parent", String(process.pid)],
      { windowsHide: true },
    );
    child.on("error", (e) => notice("browser", `сторож окон не поднялся: ${String(e?.message ?? e).split("\n")[0]}`));
    child.unref();
  } catch (e) {
    notice("browser", `сторож окон не поднялся: ${String(e?.message ?? e).split("\n")[0]}`);
  }
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
    // Одно окно уводится один раз. Владелец может вернуть его на экран кликом по значку в
    // панели задач (`show-window.ps1`) — и новая вкладка в том же окне не должна прятать его
    // обратно. Номера окон у каждого браузера свои, поэтому память — по контексту.
    let hidden = HIDDEN.get(ctx);
    if (!hidden) HIDDEN.set(ctx, (hidden = new Set()));
    if (hidden.has(windowId)) return null;
    hidden.add(windowId);
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
 * Остатки прошлых обходов: окна Opera на постоянных профилях (`profile-opera`,
 * `profile-tiktok`) или на временных профилях `amestat-…`. Свои окна владельца не трогаются
 * вовсе — отбор идёт по нашему `--user-data-dir` в командной строке процесса.
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
    // Обе копии постоянного профиля и любой временный: полос теперь две, и остаться после
    // падения может браузер каждой из них.
    if (!/profile-(opera|tiktok)/.test(line) && !/[\\/]amestat-/.test(line)) continue;
    pids.push(pid);
  }
  for (const pid of pids) await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  return { killed: pids.length, pids };
}

/**
 * Свежий одноразовый профиль и запущенный в нём браузер.
 * `proxy` — адрес пула (`proxies.mjs`) или null/домашний адрес: тогда браузер идёт с домашнего
 * адреса, как ходил всегда. Отдаёт `{ ctx, cleanup, profileDir, describe, address }`;
 * `cleanup()` закрывает браузер и стирает профиль.
 */
export async function launchFresh(choice = "", { headless = true, proxy = null, log } = {}) {
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
      ...proxyOption(proxy),
      headless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", ...LEAN_ARGS],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  } catch (e) {
    rmSync(profileDir, { recursive: true, force: true });
    const text = String(e.message ?? e).split("\n")[0];
    notice("browser", `свежий профиль не поднялся (адрес: ${addressLabel(proxy)}): ${text}`);
    throw new Error(`браузер не запустился (${browser.describe}, адрес: ${addressLabel(proxy)}): ${text}`);
  }
  log?.(`  адрес: ${addressLabel(proxy)}`);
  return { ctx, cleanup, profileDir, describe: browser.describe, address: addressLabel(proxy) };
}

/**
 * Браузер на ПОСТОЯННОМ профиле `profile-opera` — том, где вошли фейковые аккаунты.
 * Им ходят за комментариями: TikTok их гостю не отдаёт вовсе.
 *
 * ⚠️ `headless: false` — не прихоть. Комментарии TikTok в скрытом окне приходят пустым телом,
 * а следом показывается капча-пазл (проба 2026-09-08); с настоящим окном всё отдаётся сразу.
 * Чтобы окно не лезло владельцу под руку, оно уводится далеко за край экрана.
 *
 * ⚠️ ОДНА ПАПКА — ОДИН ПРОЦЕСС: пока браузер открыт, второй на этой папке не встанет. Отсюда
 * очередь обходов в `sync.mjs` и вторая копия профиля (`PROFILE_TIKTOK`) под вторую полосу.
 * Какую папку поднимать, говорит `profile`. Стирать папки нельзя — потеряется вход.
 *
 * ⚠️ Запуск делается ДВАЖДЫ. Сразу после того, как закрылся предыдущий браузер (у TikTok это
 * одноразовый профиль со списком видео), Opera поднимается через раз: процесс стартует, пишет
 * в профиль и виснет, не отдав канал управления, — 2026-09-08 это стоило целого шага
 * комментариев. Ждать по три минуты незачем: свой срок в минуту, пауза и вторая попытка.
 * ⚠️ `proxy` здесь ставится ТОЛЬКО при `AMESTAT_PROXY_SCOPE=all` и всегда один и тот же адрес
 * (`sync.mjs`, `laneProxy`): в этом профиле живут ВОШЕДШИЕ аккаунты, а смена адреса у вошедшего
 * аккаунта ловит проверки безопасности площадки. Чередовать адреса тут нельзя.
 * Отдаёт `{ ctx, cleanup, describe, profile }`; `cleanup()` закрывает браузер, профиль НЕ трогает.
 */
export async function launchProfile(choice = "", { headless = true, profile = PROFILE_OPERA, proxy = null, log } = {}) {
  const browser = resolveBrowser(choice);
  const PROFILE_DIR = profile;
  if (!existsSync(PROFILE_DIR)) {
    throw new Error(`нет копии профиля Opera (${PROFILE_DIR}) — сними её с входом фейковых аккаунтов`);
  }
  // Настоящее окно — только на шаге комментариев TikTok, и оно не должно мелькать у владельца:
  // сначала отучаем профиль разворачиваться, потом задаём место и размер ключами, а после
  // запуска окно ещё и уводится через CDP (`hideWindow`).
  if (!headless) {
    const bad = forceOffscreenPlacement(PROFILE_DIR);
    if (bad) notice("browser", `окно может открыться поверх работы (${basename(PROFILE_DIR)}): ${bad}`);
    ensureWindowWatch();
  }
  // Хвост вкладок прошлых запусков не восстанавливать — ни в окне, ни в скрытом режиме.
  const stale = forgetSession(PROFILE_DIR);
  if (stale) notice("browser", `профиль ${basename(PROFILE_DIR)} может восстановить старые вкладки: ${stale}`);
  const options = {
    ...(browser.executablePath ? { executablePath: browser.executablePath } : { channel: "chrome" }),
    ...proxyOption(proxy),
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
        notice("browser", `браузер не запустился дважды на ${basename(PROFILE_DIR)} (адрес: ${addressLabel(proxy)}): ${first}; потом ${text}`);
        throw new Error(`браузер не запустился дважды (${browser.describe}, ${basename(PROFILE_DIR)}, адрес: ${addressLabel(proxy)}): ${first}; потом ${text}`);
      }
      first = text;
      notice("browser", `браузер не встал с первого раза на ${basename(PROFILE_DIR)}, пробую ещё: ${text}`);
      await new Promise((r) => setTimeout(r, LAUNCH_RETRY_MS));
    }
  }
  log?.(`  адрес: ${addressLabel(proxy)}`);
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
    notice("browser", `профиль ${basename(PROFILE_DIR)} восстановил ${restored.length} старых вкладок — закрыты`);
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
    if (await killIfAlive(ctx)) notice("browser", `браузер не закрылся сам — пришлось добить (${basename(PROFILE_DIR)})`);
  };
  return { ctx, cleanup, describe: browser.describe, profile: PROFILE_DIR };
}

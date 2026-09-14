// Radmin VPN перед обходом: включён — выключить. Владелец, 2026-09-14.
//
// Зачем: копия Opera сборщика ходит мимо VPN через Bypasser Surfshark, а тот выпускает такой
// трафик через адаптер с наименьшей метрикой. У Radmin VPN метрика 1 и нет интернета — пока он
// включён, у копии Opera нет сети, и TikTok не собирается вовсе (14.09, обход #125: у всех
// «страница профиля не открылась»). Правило владельца: «в любой момент, когда идёт сборка и
// включён Radmin, — Radmin выключить». Вечером он Radmin пользуется, поэтому выключаем именно
// перед обходом, а не при старте компьютера.
//
// ⚠️ Резидент без прав администратора, а службу и адаптер останавливает только администратор.
// Поэтому само выключение — задача планировщика «Amestat radmin off» с наивысшими правами
// (`radmin-off.ps1`); запускать её владелец разрешил один раз, при создании, дальше её зовёт
// резидент через `schtasks /Run` без окон и запросов.
// ⚠️ Погасить Radmin мало: Surfshark переводит исключение на Wi-Fi не сразу (14.09 — через
// ~20 с). Поэтому после выключения ждём, пока копия браузера реально откроет страницу.
//
// Беды здесь обход не роняют: не вышло — пишем строку и замечание, а TikTok дальше скажет сам.

import { execFile } from "node:child_process";
import { launchFresh } from "./browser.mjs";
import { notice } from "./notices.mjs";

export const RADMIN_TASK = "Amestat radmin off";
const OFF_WAIT_MS = 60_000;      // сколько ждать, пока служба и адаптер погаснут
const POLL_MS = 2_000;
const NET_TRIES = 6;             // попыток открыть страницу копией браузера
const NET_PAUSE_MS = 5_000;
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (e) => String(e?.message ?? e).split("\n")[0];

/** Команда Windows без окна. Отдаёт `{ ok, out }`. */
function run(cmd, args) {
  return new Promise((done) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      done({ ok: !err, out: String(stdout ?? "") || String(stderr ?? "") || first(err ?? "") }));
  });
}

/**
 * Состояние Radmin из JSON, который печатает PowerShell: `{ service, adapter }` — строки статуса
 * или null, если службы/адаптера нет. Мусор на входе — «Radmin не установлен».
 * Чистая функция: её проверяют тесты (`radmin.test.mjs`).
 */
export function parseRadminState(text) {
  try {
    const json = JSON.parse(String(text ?? "").trim() || "null");
    const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { service: str(json?.service), adapter: str(json?.adapter) };
  } catch {
    return { service: null, adapter: null };
  }
}

/**
 * Мешает ли Radmin: служба работает ИЛИ адаптер не выключен. Любое из двух достаточно — живая
 * служба включает адаптер обратно, а включённый адаптер перехватывает исключение и без службы.
 */
export function radminActive({ service = null, adapter = null } = {}) {
  if (service && service.toLowerCase() === "running") return true;
  if (adapter && !["disabled", "not present"].includes(adapter.toLowerCase())) return true;
  return false;
}

/** Строка IP/страны из ответа Cloudflare trace: «185.203.152.146, BY» или null. */
export function traceLabel(text) {
  const pick = (k) => (String(text ?? "").match(new RegExp(`^${k}=(.+)$`, "m")) || [])[1]?.trim();
  const ip = pick("ip"), loc = pick("loc");
  return ip ? `${ip}${loc ? `, ${loc}` : ""}` : null;
}

async function readState() {
  const script = [
    "$s = Get-Service -Name RvControlSvc -ErrorAction SilentlyContinue",
    "$a = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -eq 'Radmin VPN' } | Select-Object -First 1",
    "@{ service = $(if ($s) { [string]$s.Status } else { $null }); adapter = $(if ($a) { [string]$a.Status } else { $null }) } | ConvertTo-Json -Compress",
  ].join("; ");
  const res = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return parseRadminState(res.out);
}

/** Открывает ли копия браузера страницу. Отдаёт метку адреса или null. */
async function browserOnline(browserChoice) {
  let launched = null;
  try {
    launched = await launchFresh(browserChoice, {});
    const page = await launched.ctx.newPage();
    await page.goto(TRACE_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
    return traceLabel(await page.evaluate(() => document.body?.innerText ?? "")) ?? "?";
  } catch {
    return null;
  } finally {
    await launched?.cleanup?.().catch(() => {});
  }
}

/**
 * Перед обходом: Radmin включён — выключить задачей планировщика и дождаться сети у браузера.
 * Выключен или не установлен — ничего не делает и молчит.
 * Отдаёт `{ was, off, online }`: был ли включён, погас ли, адрес браузера после (или null).
 */
export async function ensureRadminOff({ browserChoice = "", log } = {}) {
  if (process.platform !== "win32") return { was: false, off: true, online: null };
  const before = await readState();
  if (!radminActive(before)) return { was: false, off: true, online: null };

  log?.(`Radmin включён (служба ${before.service ?? "—"}, адаптер ${before.adapter ?? "—"}) — выключаю перед обходом: с ним у браузера нет сети мимо VPN`);
  const started = await run("schtasks.exe", ["/Run", "/TN", RADMIN_TASK]);
  if (!started.ok) {
    const text = `Radmin не выключен: задача «${RADMIN_TASK}» не запустилась (${first(started.out)})`;
    log?.(text);
    notice("browser", text);
    return { was: true, off: false, online: null };
  }

  const until = Date.now() + OFF_WAIT_MS;
  let state = before;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    state = await readState();
    if (!radminActive(state)) break;
  }
  if (radminActive(state)) {
    const text = `Radmin не погас за ${OFF_WAIT_MS / 1000} с (служба ${state.service ?? "—"}, адаптер ${state.adapter ?? "—"}) — обход идёт как есть`;
    log?.(text);
    notice("browser", text);
    return { was: true, off: false, online: null };
  }

  for (let i = 1; i <= NET_TRIES; i++) {
    const online = await browserOnline(browserChoice);
    if (online) {
      log?.(`Radmin выключен, браузер вышел в сеть (${online}) — продолжаю обход`);
      return { was: true, off: true, online };
    }
    if (i < NET_TRIES) await sleep(NET_PAUSE_MS);
  }
  const text = `Radmin выключен, но браузер так и не вышел в сеть за ${NET_TRIES} попыток — обход идёт как есть`;
  log?.(text);
  notice("browser", text);
  return { was: true, off: true, online: null };
}

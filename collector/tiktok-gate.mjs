// Сколько раз подряд можно поднять чистый профиль TikTok. Владелец, 2026-09-09.
//
// Зачем: список видео TikTok отдаёт только СВЕЖЕМУ профилю, поэтому на каждого креатора идёт
// свой одноразовый запуск браузера. Несколько таких запусков подряд с одного домашнего адреса
// TikTok считает за очередь и какое-то время отвечает пустыми `item_list` вообще всем — это и
// есть «защита по адресу». Лечится только паузой: не больше `AMESTAT_TT_LAUNCHES` запусков за
// скользящие `AMESTAT_TT_WINDOW_MIN` минут (пусто — 6 за 15).
//
// ⚠️ Счёт общий на ВЕСЬ компьютер, а не на процесс: резидент и разовый `run.mjs` могут идти
// в один час, и каждый со своим счётчиком быстро сожжёт лимит вдвоём. Поэтому метки запусков
// лежат в файле `logs/tiktok-launches.json` — простой массив отметок времени; всё старше окна
// вычищается при каждом обращении.
//
// ⚠️ Ожидание НЕ роняет полосу Instagram: `sync.mjs` ведёт полосы через `Promise.all`, и пока
// TikTok ждёт окна, Instagram спокойно идёт дальше.
//
// ⚠️ Лимит — НА КАЖДЫЙ АДРЕС ОТДЕЛЬНО (2026-09-09, вместе с пулом прокси). Придерживает-то
// TikTok адрес, а не компьютер: шесть запусков с домашнего адреса не мешают шести запускам с
// прокси. Поэтому метка теперь `{ at, address }`, а `launchAllowed` считает только метки своего
// адреса. Старые записи (голое число) считаются домашними — адрес был один.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { collectorDir } from "./env.mjs";
import { HOME, nextAddress, readProxyState, writeProxyState, PROXY_STATE_FILE } from "./proxies.mjs";

const STATE_FILE = resolve(collectorDir, "logs", "tiktok-launches.json");
const RECHECK_MS = 60_000;   // просыпаемся не реже раза в минуту: окно могли занять другие
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Отметка в понятном виде: `{ at, address }`. Голое число — запуск с домашнего адреса. */
function stampOf(raw) {
  if (typeof raw === "number" || typeof raw === "string") {
    const at = Number(raw);
    return Number.isFinite(at) ? { at, address: 0 } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  const address = Number(raw.address);
  return { at, address: Number.isFinite(address) ? address : 0 };
}

/**
 * Можно ли поднимать чистый профиль С ЭТОГО АДРЕСА прямо сейчас.
 * `stamps` — отметки прошлых запусков (`{ at, address }` или голое число), в любом порядке и с
 * любым мусором внутри. `address` — номер адреса пула (0 — домашний).
 * Отдаёт `{ ok, waitMs }`: `waitMs` — сколько ждать, пока самая старая из «свежих» отметок
 * этого адреса выйдет за окно и освободит место.
 * Чистая функция: её проверяют тесты (`tiktok-gate.test.mjs`).
 */
export function launchAllowed(stamps, now, limit = 6, windowMs = 15 * 60_000, address = 0) {
  const want = Number(address) || 0;
  const fresh = (stamps ?? [])
    .map(stampOf)
    .filter((s) => s && s.address === want && now - s.at < windowMs && s.at <= now)
    .map((s) => s.at)
    .sort((a, b) => a - b);
  if (fresh.length < limit) return { ok: true, waitMs: 0 };
  // Место освободится, когда истечёт отметка, стоящая `limit`-й с конца.
  const blocking = fresh[fresh.length - limit];
  return { ok: false, waitMs: Math.max(0, blocking + windowMs - now) };
}

/**
 * Отметки из файла, уже в виде `{ at, address }`. Файла нет или он испорчен — считаем, что
 * запусков не было.
 */
export function readLaunches(file = STATE_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw.map(stampOf).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Отметки в файл, уже без старья. Не записалось — работу не валим: лимит просто мягче. */
function writeLaunches(stamps, file = STATE_FILE) {
  try {
    mkdirSync(resolve(collectorDir, "logs"), { recursive: true });
    writeFileSync(file, JSON.stringify(stamps), "utf8");
    return null;
  } catch (e) {
    return String(e?.message ?? e).split("\n")[0];
  }
}

/**
 * Взять АДРЕС и место под запуск чистого профиля разом: берём следующий по кругу адрес, у
 * которого нет паузы и не исчерпан лимит запусков; такого нет — ЖДЁМ ближайшего освобождения и
 * пробуем снова.
 *
 * `addresses` — пул (`env.proxyAddresses`); пусто — только домашний адрес, как было всегда.
 * `exclude` — номера адресов, которые в этот раз не годятся (тот, что только что отдал пустой
 * список): исключили всех — отдаём `address: null`, второй попытки не будет.
 * `onWait(until, waitMs, { addresses })` зовётся один раз на каждое ожидание (в `sync.mjs` он
 * пишет строку в лог и в `sync_log`, а в `sync_runs.current_handles` кладёт «пауза TikTok до
 * HH:MM»). `onFree(waited, address)` — когда место освободилось после ожидания.
 * Отдаёт `{ waited, address }`: `waited` — сколько миллисекунд суммарно прождали (0, если ждать
 * не пришлось), `address` — с какого адреса идти.
 */
export async function takeLaunchSlot({
  limit = 6,
  windowMs = 15 * 60_000,
  addresses = null,
  exclude = [],
  onWait = null,
  onFree = null,
  file = STATE_FILE,
  stateFile = PROXY_STATE_FILE,
  now = () => Date.now(),
  sleepFn = sleep,
  stop = () => false,
} = {}) {
  const pool = (addresses ?? []).length > 0 ? addresses : [{ ...HOME }];
  let waited = 0;
  for (;;) {
    const at = now();
    const stamps = readLaunches(file);
    const picked = nextAddress(readProxyState(stateFile), at, pool, {
      exclude,
      free: (address) => launchAllowed(stamps, at, limit, windowMs, address.id),
    });
    // Годных адресов не осталось вовсе (все исключены) — ждать нечего и некого.
    if (!picked.address) return { waited, address: null };
    if (picked.waitMs === 0) {
      const fresh = stamps.filter((s) => at - s.at < windowMs);
      writeLaunches([...fresh, { at, address: picked.address.id }], file);
      // Круг проворачивается только по факту запуска: холостые пересчёты его не двигают.
      writeProxyState(picked.state, stateFile);
      if (waited > 0) onFree?.(waited, picked.address);
      return { waited, address: picked.address };
    }
    if (stop()) return { waited, address: null, cancelled: true };
    // Говорим об ожидании ОДИН раз: просыпаемся мы раз в минуту, а десять одинаковых строк
    // «ждём паузу TikTok» в журнале — шум, а не новость.
    if (waited === 0) onWait?.(new Date(at + picked.waitMs), picked.waitMs, { addresses: pool.length });
    // Просыпаемся не реже раза в минуту: окно могли занять другим процессом, и пересчитать
    // надо по свежему файлу, а не по старому расчёту.
    const nap = Math.max(1_000, Math.min(picked.waitMs + 500, RECHECK_MS));
    await sleepFn(nap);
    waited += nap;
  }
}

export { STATE_FILE as LAUNCHES_FILE };

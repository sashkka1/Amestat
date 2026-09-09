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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { collectorDir } from "./env.mjs";

const STATE_FILE = resolve(collectorDir, "logs", "tiktok-launches.json");
const RECHECK_MS = 60_000;   // просыпаемся не реже раза в минуту: окно могли занять другие
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Можно ли поднимать чистый профиль прямо сейчас.
 * `stamps` — отметки прошлых запусков (мс эпохи), в любом порядке и с любым мусором внутри.
 * Отдаёт `{ ok, waitMs }`: `waitMs` — сколько ждать, пока самая старая из «свежих» отметок
 * выйдет за окно и освободит место.
 * Чистая функция: её проверяют тесты (`tiktok-gate.test.mjs`).
 */
export function launchAllowed(stamps, now, limit = 6, windowMs = 15 * 60_000) {
  const fresh = (stamps ?? [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && now - t < windowMs && t <= now)
    .sort((a, b) => a - b);
  if (fresh.length < limit) return { ok: true, waitMs: 0 };
  // Место освободится, когда истечёт отметка, стоящая `limit`-й с конца.
  const blocking = fresh[fresh.length - limit];
  return { ok: false, waitMs: Math.max(0, blocking + windowMs - now) };
}

/** Отметки из файла. Файла нет или он испорчен — считаем, что запусков не было. */
export function readLaunches(file = STATE_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw.map(Number).filter((t) => Number.isFinite(t)) : [];
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
 * Взять место под запуск чистого профиля: если окно свободно — сразу отметиться и вернуться,
 * если нет — ПОДОЖДАТЬ и попробовать снова.
 *
 * `onWait(until, waitMs)` зовётся один раз на каждое ожидание (в `sync.mjs` он пишет строку в
 * лог и в `sync_log`, а в `sync_runs.current_handles` кладёт «пауза TikTok до HH:MM»).
 * `onFree()` — когда окно освободилось после ожидания.
 * Отдаёт `{ waited }` — сколько миллисекунд суммарно прождали (0, если ждать не пришлось).
 */
export async function takeLaunchSlot({
  limit = 6,
  windowMs = 15 * 60_000,
  onWait = null,
  onFree = null,
  file = STATE_FILE,
  now = () => Date.now(),
  sleepFn = sleep,
  stop = () => false,
} = {}) {
  let waited = 0;
  for (;;) {
    const at = now();
    const stamps = readLaunches(file);
    const { ok, waitMs } = launchAllowed(stamps, at, limit, windowMs);
    if (ok) {
      const fresh = stamps.filter((t) => at - t < windowMs);
      writeLaunches([...fresh, at], file);
      if (waited > 0) onFree?.(waited);
      return { waited };
    }
    if (stop()) return { waited, cancelled: true };
    // Говорим об ожидании ОДИН раз: просыпаемся мы раз в минуту, а десять одинаковых строк
    // «ждём паузу TikTok» в журнале — шум, а не новость.
    if (waited === 0) onWait?.(new Date(at + waitMs), waitMs);
    // Просыпаемся не реже раза в минуту: окно могли занять другим процессом, и пересчитать
    // надо по свежему файлу, а не по старому расчёту.
    const nap = Math.max(1_000, Math.min(waitMs + 500, RECHECK_MS));
    await sleepFn(nap);
    waited += nap;
  }
}

export { STATE_FILE as LAUNCHES_FILE };

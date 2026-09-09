// Пул адресов, с которых сборщик ходит за списком видео TikTok. Владелец, 2026-09-09:
// «если можешь реализовать прокси — прекрасно».
//
// Зачем: TikTok придерживает не профиль браузера, а АДРЕС. Отсюда лимит запусков
// (`tiktok-gate.mjs`) и пустые `item_list` у всех подряд, когда лимит исчерпан. Адрес — это и
// есть потолок скорости обхода; несколько адресов поднимают потолок во столько же раз.
//
// Как устроено:
//   • адреса нумерованы: #0 — домашний (участвует, пока `AMESTAT_PROXY_HOME` не `off`),
//     #1…#N — прокси из `AMESTAT_PROXIES` в порядке перечисления. Номера СТАБИЛЬНЫ: выключенный
//     домашний адрес не сдвигает нумерацию прокси, иначе строки прошлых логов начали бы врать;
//   • чередование по кругу МЕЖДУ ЗАПУСКАМИ: курсор лежит в `logs/proxies-state.json`, поэтому
//     `run.mjs` и резидент делят очередь, а не гоняют оба первый адрес;
//   • здоровье: адрес, давший пустой список или ошибку соединения, уходит в паузу на
//     `AMESTAT_PROXY_COOLDOWN_MIN` минут (`markBad`), удачный запуск сбрасывает счётчик
//     (`markGood`). Все в паузе — берём того, у кого пауза кончится раньше, и ЖДЁМ его,
//     ровно как ждём окна лимита запусков;
//   • лимит запусков считается ОТДЕЛЬНО на каждый адрес — проверка приходит сюда параметром
//     `free` из `tiktok-gate.mjs`, чтобы кольца импортов не было.
//
// 🔴 Логин и пароль прокси живут только в `.env.local` и в объекте адреса. В логи, в `sync_log`,
// в замечания Telegram и в текст ошибки идёт ТОЛЬКО `label` — «прокси #2 host:port», без учётных
// данных. `server` тоже собирается без них: Playwright принимает логин и пароль отдельными полями.
//
// ⚠️ `env.mjs` импортирует этот файл (разбор настроек), поэтому обратно `env.mjs` сюда НЕ
// импортируется: путь к своей папке считается от `import.meta.url`, кольца нет.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROXY_STATE_FILE = resolve(HERE, "logs", "proxies-state.json");

/** Домашний адрес: тот, с которого сборщик ходил всегда. Прокси у него нет вовсе. */
export const HOME = { id: 0, label: "домашний", server: null, username: "", password: "" };

// Что умеет Chromium через Playwright. `socks5h` и `socks4` пишут в строке подключения, но
// Chromium знает `socks5` и `socks4`; `socks5h` приводим к `socks5` — разница только в том,
// кто резолвит имя, а у нас в адресе всегда IP или имя хоста прокси.
const SCHEMES = new Set(["http", "https", "socks5", "socks5h", "socks4"]);

/**
 * Разбор `AMESTAT_PROXIES`: строки через запятую вида `http://user:pass@host:port`,
 * `https://…`, `socks5://user:pass@host:port`. Мусор и неизвестные схемы пропускаются молча —
 * из-за опечатки в настройке обход вставать не должен.
 * Отдаёт `[{ server, username, password, host }]`; `server` — без учётных данных.
 * ⚠️ Пароль со знаками `@`, `:`, `/` пишется процентами (`%40`): иначе адрес не разберётся.
 * Чистая функция: её проверяют тесты.
 */
export function parseProxies(raw) {
  const out = [];
  for (const piece of String(raw ?? "").split(",")) {
    const text = piece.trim();
    if (!text) continue;
    let url = null;
    try {
      url = new URL(text);
    } catch {
      continue;   // не адрес вовсе
    }
    const scheme = url.protocol.replace(":", "").toLowerCase();
    if (!SCHEMES.has(scheme) || !url.hostname) continue;
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    out.push({
      server: `${scheme === "socks5h" ? "socks5" : scheme}://${host}`,
      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
      host,
    });
  }
  return out;
}

/**
 * Список адресов пула: домашний (если включён) и прокси по порядку.
 * Отдаёт `[{ id, label, server, username, password }]`. Пусто не бывает: выключили домашний и
 * не задали ни одного прокси — работаем как раньше, с домашнего.
 * Чистая функция: её проверяют тесты.
 */
export function addressList(proxies, { home = true } = {}) {
  const list = home ? [{ ...HOME }] : [];
  (proxies ?? []).forEach((p, i) => {
    list.push({
      id: i + 1,
      label: `прокси #${i + 1} ${p.host}`,
      server: p.server,
      username: p.username ?? "",
      password: p.password ?? "",
    });
  });
  return list.length > 0 ? list : [{ ...HOME }];
}

/** Имя адреса по номеру — для логов и текстов ошибок. Не нашёлся — так и говорим. */
export function labelOf(addresses, id) {
  return (addresses ?? []).find((a) => a.id === Number(id))?.label ?? `адрес #${id}`;
}

/** Пустое состояние пула. */
export function emptyState() {
  return { cursor: 0, bad: {}, fails: {}, runs: {} };
}

/** Состояние из чего попало (файл могли испортить руками) — в понятный вид. Чистая функция. */
export function normalizeState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const numbers = (obj) => {
    const out = {};
    for (const [key, value] of Object.entries(obj && typeof obj === "object" ? obj : {})) {
      const n = Number(value);
      if (Number.isFinite(n)) out[String(Number(key))] = n;
    }
    return out;
  };
  const cursor = Number(src.cursor);
  return {
    cursor: Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0,
    bad: numbers(src.bad),
    fails: numbers(src.fails),
    runs: numbers(src.runs),
  };
}

/** До какого момента адрес в паузе (0 — не в паузе). Чистая функция. */
export function pausedUntil(state, id, now) {
  const until = Number(normalizeState(state).bad[String(id)] ?? 0);
  return Number.isFinite(until) && until > now ? until : 0;
}

/**
 * Адрес подвёл: пустой список или ошибка соединения — пауза на `cooldownMs` и +1 к счётчику.
 * Чистая функция: отдаёт НОВОЕ состояние.
 */
export function markBad(state, id, now, cooldownMs = 30 * 60_000) {
  const next = normalizeState(state);
  const key = String(Number(id));
  next.bad[key] = now + Math.max(0, cooldownMs);
  next.fails[key] = (next.fails[key] ?? 0) + 1;
  return next;
}

/** Адрес сработал: паузы нет, счётчик неудач обнулён. Чистая функция. */
export function markGood(state, id, now = Date.now()) {
  const next = normalizeState(state);
  const key = String(Number(id));
  delete next.bad[key];
  next.fails[key] = 0;
  next.runs[key] = (next.runs[key] ?? 0) + 1;
  next.lastGoodAt = now;
  return next;
}

/**
 * Следующий адрес по кругу.
 *
 * Берём первый, у которого нет паузы и есть место по лимиту запусков (`free`). Нет такого —
 * отдаём тот, что освободится раньше всех, и `waitMs` до этого мига: ждать один адрес правильнее,
 * чем сжигать пустыми запусками остальные.
 *
 * `addresses` — пул (`addressList`), `exclude` — номера, которые в этот раз не годятся (адрес,
 * только что отдавший пустой список), `free(address, now) → { ok, waitMs }` — проверка лимита
 * запусков; её даёт `tiktok-gate.mjs`, поэтому обратного импорта здесь нет.
 *
 * Отдаёт `{ address, state, waitMs }`; `address` — null, если годных адресов не осталось вовсе.
 * ⚠️ Курсор в отданном состоянии уже сдвинут — записывать это состояние надо ТОЛЬКО когда
 * запуск действительно случился, иначе круг провернётся на каждом холостом пересчёте.
 * Чистая функция: её проверяют тесты.
 */
export function nextAddress(state, now, addresses, { exclude = [], free = () => ({ ok: true, waitMs: 0 }) } = {}) {
  const st = normalizeState(state);
  const pool = (addresses ?? []).length > 0 ? addresses : [{ ...HOME }];
  const skip = new Set((exclude ?? []).map(Number));
  const order = [];
  for (let k = 0; k < pool.length; k++) {
    const a = pool[(st.cursor + k) % pool.length];
    if (!skip.has(Number(a.id))) order.push(a);
  }
  if (order.length === 0) return { address: null, state: st, waitMs: 0 };

  let ready = null, soonest = null;
  for (const address of order) {
    const until = pausedUntil(st, address.id, now);
    const cooling = until > 0 ? until - now : 0;
    const limit = free(address, now) ?? { ok: true, waitMs: 0 };
    const wait = Math.max(cooling, limit.ok ? 0 : Math.max(0, Number(limit.waitMs) || 0));
    if (wait === 0) {
      ready = address;
      break;
    }
    if (soonest === null || wait < soonest.wait) soonest = { address, wait };
  }
  const address = ready ?? soonest?.address ?? null;
  const waitMs = ready ? 0 : soonest?.wait ?? 0;
  const at = pool.findIndex((a) => a.id === address?.id);
  const cursor = at < 0 ? st.cursor : (at + 1) % pool.length;
  return { address, state: { ...st, cursor }, waitMs };
}

// Похоже на беду с самим адресом, а не с площадкой: прокси не отозвался, не пустил, оборвал.
// Такой адрес уходит в паузу — следующему креатору он всё равно ответит тем же.
const TROUBLE_RE = /ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_EMPTY_RESPONSE|Proxy connection failed|407/i;

/** Ошибка похожа на «адрес не работает»? Чистая функция: её проверяют тесты. */
export function looksLikeProxyTrouble(text) {
  return TROUBLE_RE.test(String(text ?? ""));
}

// ------------------------------------------------------------------ состояние на диске
// Файл делят все процессы сборщика: резидент и разовый `run.mjs`. Не прочиталось или не
// записалось — работу не валим: пул просто теряет память о круге и паузах.

/** Состояние пула из файла. Файла нет или он испорчен — считаем, что пул чистый. */
export function readProxyState(file = PROXY_STATE_FILE) {
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptyState();
  }
}

/** Состояние пула в файл. Отдаёт текст беды или null. */
export function writeProxyState(state, file = PROXY_STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(normalizeState(state)), "utf8");
    return null;
  } catch (e) {
    return String(e?.message ?? e).split("\n")[0];
  }
}

/** Пауза адресу — прочитать, пометить, записать. Отдаёт момент конца паузы. */
export function rememberBad(id, cooldownMs = 30 * 60_000, { file = PROXY_STATE_FILE, now = Date.now() } = {}) {
  const next = markBad(readProxyState(file), id, now, cooldownMs);
  writeProxyState(next, file);
  return now + cooldownMs;
}

/** Удачный запуск адреса — прочитать, пометить, записать. */
export function rememberGood(id, { file = PROXY_STATE_FILE, now = Date.now() } = {}) {
  writeProxyState(markGood(readProxyState(file), id, now), file);
}

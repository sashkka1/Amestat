// Проверка пула адресов: с какого адреса мы на самом деле выходим в интернет и отдаёт ли
// TikTok список через него.
//
//   node proxy-check.mjs                     # только внешний IP каждого адреса
//   node proxy-check.mjs --tiktok            # плюс список видео у AMESTAT_PROXY_CHECK_HANDLE
//   node proxy-check.mjs --tiktok --handle X # у другого креатора
//
// Правила те же, что у обхода: окон не показываем (браузер headless), браузеры закрываем всегда,
// учётные данные прокси не печатаем — только подпись «прокси #2 host:port».
//
// ⚠️ Проверка `--tiktok` поднимает НАСТОЯЩИЙ чистый профиль и тратит запуск с этого адреса —
// ровно как обход. Лимит запусков она при этом не спрашивает и метку не ставит: это разовая
// проба руками, а не работа по расписанию. Гонять её подряд по десять раз не стоит: адрес
// придержат, и обход получит пустые списки.

import { loadEnv } from "./env.mjs";
import { launchFresh } from "./browser.mjs";
import { collectTikTok } from "./tiktok.mjs";
import { parseProxies, addressList } from "./proxies.mjs";

const IP_URL = "https://api.ipify.org?format=json";
const IP_TIMEOUT_MS = 30_000;

const short = (e) => String(e?.message ?? e).split("\n")[0];

function parseArgs(argv) {
  const out = { tiktok: false, handle: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tiktok") out.tiktok = true;
    else if (arg === "--handle") out.handle = String(argv[++i] ?? "").replace(/^@/, "");
  }
  return out;
}

/** Внешний IP с этого адреса. Отдаёт `{ ip, ms }` или бросает Error с русским текстом. */
async function externalIp(address, browserChoice) {
  const started = Date.now();
  const { ctx, cleanup } = await launchFresh(browserChoice, { headless: true, proxy: address });
  try {
    const page = await ctx.newPage();
    const res = await page.goto(IP_URL, { waitUntil: "domcontentloaded", timeout: IP_TIMEOUT_MS });
    const body = await page.evaluate(() => document.body?.innerText ?? "");
    let ip = "";
    try {
      ip = JSON.parse(body)?.ip ?? "";
    } catch {
      // Ответ не json — бывает у прокси со своей страницей-заглушкой: покажем как есть.
      ip = body.trim().slice(0, 60);
    }
    if (!ip) throw new Error(`ответ без адреса (код ${res?.status() ?? "?"})`);
    return { ip, ms: Date.now() - started };
  } finally {
    await cleanup();
  }
}

/** Список видео креатора через этот адрес. Отдаёт число видео или бросает Error. */
async function tiktokList(address, browserChoice, handle) {
  // Пул из одного адреса и без пометок: проверка не должна ставить адресу паузу и не должна
  // ходить вторым кругом — она про «работает или нет», а не про сбор.
  let given = false;
  const pool = {
    async take() {
      if (given) return null;
      given = true;
      return address;
    },
    bad() {},
    good() {},
  };
  const { videos } = await collectTikTok({ handle }, { browserChoice, depth: "all", pool });
  return videos.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  // Разовая проверка адреса, которого в `.env.local` ещё нет: `AMESTAT_PROXIES=… node proxy-check.mjs`.
  // Только для этой команды — обход настройки из окружения не берёт вовсе (`env.mjs` читает файл).
  const fromEnv = (process.env.AMESTAT_PROXIES ?? "").trim();
  const addresses = fromEnv ? addressList(parseProxies(fromEnv), { home: env.proxyHome }) : env.proxyAddresses;
  if (fromEnv) console.log("адреса взяты из переменной окружения AMESTAT_PROXIES (в .env.local не заглядываем)");
  const handle = args.handle || env.proxyCheckHandle;

  console.log(`Адресов в пуле: ${addresses.length} (домашний ${env.proxyHome ? "участвует" : "выключен"}, прокси ${addresses.filter((a) => a.id > 0).length})`);
  let bad = 0;
  for (const address of addresses) {
    try {
      const { ip, ms } = await externalIp(address, env.browser);
      console.log(`адрес #${address.id} ${address.label} → внешний IP ${ip}, ${ms} мс`);
    } catch (e) {
      bad++;
      console.log(`адрес #${address.id} ${address.label} → не вышло: ${short(e)}`);
    }
  }

  if (args.tiktok) {
    console.log(`\nСписок видео @${handle} через каждый адрес:`);
    for (const address of addresses) {
      try {
        const count = await tiktokList(address, env.browser, handle);
        console.log(`адрес #${address.id} ${address.label} → видео ${count}`);
      } catch (e) {
        console.log(`адрес #${address.id} ${address.label} → не вышло: ${short(e)}`);
      }
    }
  }

  // Код возврата: 0 — все адреса отозвались, 1 — хоть один нет. Годится для планировщика.
  process.exitCode = bad > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(short(e));
  process.exitCode = 1;
});

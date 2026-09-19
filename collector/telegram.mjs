// Сообщение владельцу в Telegram — единственный случай, когда сборщик сам зовёт человека:
// обход по расписанию не удался, и повтор через час тоже. Больше поводов нет.
//
// Почему Bot API, а не почта: бот уже заведён, сообщение приходит на телефон мгновенно и
// не требует ни сервера, ни ящика. Ходим одним POST на `sendMessage`, без библиотек.
//
// ⚠️ Токен лежит в адресе запроса, поэтому наружу (в лог, в текст ошибки) не уходит никогда:
// всё, что печатается, прогоняется через `hide()`.
//
// Ничего не настроено (нет токена или пустой `TELEGRAM_CHAT_ID` — владелец ещё не писал боту)
// — это не ошибка: строка в лог, текст сообщения туда же, и работа идёт дальше. Потерять
// обход из-за ненастроенного мессенджера было бы хуже, чем не получить сообщение.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, envPath, collectorDir } from "./env.mjs";
import { TEST_MESSAGE_RU, nightDigestRu } from "./telegram-ru.mjs";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

/** Убирает токен из любого текста, который пойдёт в лог или в текст ошибки. */
function hide(text, token) {
  const s = String(text ?? "").split("\n")[0];
  return token ? s.split(token).join("<token>") : s;
}

async function callApi(token, method, body) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Telegram response could not be parsed (HTTP ${res.status})`);
  }
  if (!json?.ok) {
    throw new Error(`Telegram refused (HTTP ${res.status}): ${json?.description ?? "no text"}`);
  }
  return json.result;
}

// ------------------------------------------------------------------ ночь
// Владелец, 2026-09-19: «я живу в Беларуси — если обход идёт ночью, уведомлять меня ночью не
// нужно; было бы неплохо, чтобы они собирались и в 7:00 утра все отправлялись разом».
// Ночь — с 23:00 до 07:00 по Минску. Письмо, родившееся ночью, НЕ теряется: оно ложится в
// `logs/telegram-night.json`, а утром резидент (`watch.mjs`, раз в минуту) отправляет всё
// накопленное одним сообщением, с временем каждого.
//
// ⚠️ Держится ЛЮБОЕ письмо сборщика — и обхода, и резидента: дверь в Telegram у сборщика одна,
// эта функция. Сторож в базе (pg_cron, «домашний сборщик не отвечает») пишет в Telegram сам,
// мимо сборщика, и этим правилом не держится — он отвечает на кнопку, которую ночью никто не жмёт.
// ⚠️ Компьютер выключили до утра — накопленное уйдёт при первом включении, а не в 07:00.
export const NIGHT_FROM = 23;
export const NIGHT_TO = 7;
export const NIGHT_TZ = "Europe/Minsk";
const NIGHT_FILE = resolve(collectorDir, "logs", "telegram-night.json");

const minskHour = new Intl.DateTimeFormat("en-GB", { timeZone: NIGHT_TZ, hour: "numeric", hourCycle: "h23" });

/** Идёт ли ночь по Минску в этот момент. Чистая: время приходит параметром. */
export function isNight(date = new Date()) {
  const part = minskHour.formatToParts(date).find((x) => x.type === "hour");
  const hour = Number(part?.value ?? 12);
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

function readNight() {
  try {
    const items = JSON.parse(readFileSync(NIGHT_FILE, "utf8"));
    return Array.isArray(items) ? items.filter((i) => typeof i?.text === "string") : [];
  } catch {
    // Файла нет — ночью писем не было. Битый — начинаем заново: письма из него уже в логе.
    return [];
  }
}

function writeNight(items) {
  mkdirSync(resolve(collectorDir, "logs"), { recursive: true });
  writeFileSync(NIGHT_FILE, JSON.stringify(items, null, 1), "utf8");
}

let flushing = false;

/**
 * Утро: отправить всё, что накопилось за ночь. Ночью и при пустой очереди — ничего не делает.
 * Не дошло — очередь остаётся целиком (или без уже ушедших частей) до следующей попытки.
 * Отдаёт число отправленных писем.
 */
export async function flushNight({ log = console.log, now = new Date() } = {}) {
  if (flushing || isNight(now)) return 0;
  const items = readNight();
  if (items.length === 0) return 0;
  flushing = true;
  try {
    let sent = 0;
    for (const part of nightDigestRu(items, { from: NIGHT_FROM, to: NIGHT_TO, tz: NIGHT_TZ })) {
      const ok = await sendTelegram(part.text, { log, force: true });
      if (!ok) {
        writeNight(items.slice(sent));
        log(`morning: the messages held overnight were not sent, ${items.length - sent} stay in the queue`);
        return sent;
      }
      sent += part.count;
    }
    writeNight([]);
    log(`morning: ${sent} message(s) held overnight were sent`);
    return sent;
  } finally {
    flushing = false;
  }
}

/**
 * Шлёт владельцу одно сообщение обычным текстом (без markdown — в тексте бывают @ и _,
 * и разметка на них ломается вместе с сообщением).
 * Отдаёт `true`, если Telegram принял (или ночью письмо легло в очередь до утра); `false` —
 * если не настроено или не дошло.
 * `force` — слать и ночью: так уходит утренняя пачка и пробное `--test`.
 * Исключений не бросает: звонок владельцу не имеет права свалить обход.
 */
export async function sendTelegram(text, { log = console.log, force = false, now = new Date() } = {}) {
  const { telegramToken, telegramChatId } = loadEnv();
  if (!telegramToken || !telegramChatId) {
    log("Telegram is not configured, the message was not sent");
    log(text);
    return false;
  }
  if (!force && isNight(now)) {
    try {
      writeNight([...readNight(), { at: now.toISOString(), text }]);
      log(`night hours (${NIGHT_FROM}:00–0${NIGHT_TO}:00, ${NIGHT_TZ}): the message is held until 0${NIGHT_TO}:00`);
      return true;
    } catch (e) {
      // Положить некуда — лучше разбудить, чем потерять.
      log(`night hours: could not hold the message (${hide(e?.message ?? e, telegramToken)}), sending it now`);
    }
  }
  try {
    await callApi(telegramToken, "sendMessage", { chat_id: telegramChatId, text });
    return true;
  } catch (e) {
    log(`Telegram: the message was not sent — ${hide(e?.message ?? e, telegramToken)}`);
    log(text);
    return false;
  }
}

/**
 * Кто писал боту: id личного чата первого написавшего, его имя и @ник.
 * Отдаёт `null`, если боту никто не писал (или все обновления уже прочитаны другим клиентом).
 */
export async function findChat({ log = console.log } = {}) {
  const { telegramToken } = loadEnv();
  if (!telegramToken) throw new Error(`TELEGRAM_BOT_TOKEN is empty in ${envPath} — @BotFather issues the token`);
  let updates;
  try {
    updates = await callApi(telegramToken, "getUpdates", { limit: 100 });
  } catch (e) {
    throw new Error(hide(e?.message ?? e, telegramToken));
  }
  for (const u of updates ?? []) {
    const msg = u.message ?? u.edited_message ?? null;
    const chat = msg?.chat;
    if (!chat || chat.type !== "private") continue;
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || null;
    return { id: String(chat.id), name, username: chat.username ?? null };
  }
  log(`nobody has written to the bot yet: send it any message and try again (updates in the queue: ${updates?.length ?? 0})`);
  return null;
}

/** Подставляет chat id в `TELEGRAM_CHAT_ID` в `../.env.local`; остальной файл не трогает. */
export function saveChatId(id) {
  const text = readFileSync(envPath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `TELEGRAM_CHAT_ID=${id}`;
  const next = /^TELEGRAM_CHAT_ID=.*$/m.test(text)
    ? text.replace(/^TELEGRAM_CHAT_ID=.*$/m, line)
    : text.replace(/(\r?\n)*$/, `${eol}${line}${eol}`);
  writeFileSync(envPath, next, "utf8");
}

// ------------------------------------------------------------------ запуск из командной строки
//   node telegram.mjs --test              — послать пробное сообщение
//   node telegram.mjs --chat-id           — показать id личного чата первого написавшего боту
//   node telegram.mjs --chat-id --save    — и вписать его в ../.env.local
// (сравнение через pathToFileURL: на Windows argv[1] — путь с обратными слэшами, а import.meta.url — file:///C:/…)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const has = (name) => argv.includes(name);

  try {
    if (has("--help") || has("-h") || argv.length === 0) {
      console.log("node telegram.mjs --test            send a test message");
      console.log("node telegram.mjs --chat-id [--save] look up the chat id (and write it into ../.env.local)");
      process.exit(0);
    }

    const { telegramToken, telegramChatId } = loadEnv();
    if (!telegramToken) {
      console.error(`✗ TELEGRAM_BOT_TOKEN is empty in ${envPath} — @BotFather issues the token`);
      process.exit(2);
    }

    if (has("--chat-id")) {
      const chat = await findChat();
      if (!chat) process.exit(1);
      console.log(`chat id: ${chat.id}${chat.name ? `, ${chat.name}` : ""}${chat.username ? `, @${chat.username}` : ""}`);
      if (has("--save")) {
        saveChatId(chat.id);
        console.log(`✓ written to TELEGRAM_CHAT_ID in ${envPath}`);
      } else {
        console.log("to write it into .env.local, repeat with --save");
      }
      process.exit(0);
    }

    if (has("--test")) {
      if (!telegramChatId) {
        console.error(`✗ TELEGRAM_CHAT_ID is empty in ${envPath} — send the bot any message and run: node telegram.mjs --chat-id --save`);
        process.exit(2);
      }
      // Само сообщение — по-русски, как и все письма в Telegram (владелец, 2026-09-17); консоль — английская.
      // Пробное сообщение уходит и ночью: его шлют руками, чтобы проверить бота сейчас.
      const ok = await sendTelegram(TEST_MESSAGE_RU, { force: true });
      console.log(ok ? "✓ sent" : "✗ not sent");
      process.exit(ok ? 0 : 1);
    }

    console.error(`✗ unknown flag: ${argv.join(" ")}. Available: --test and --chat-id [--save]`);
    process.exit(2);
  } catch (e) {
    // Понятная строка вместо стека: сюда попадает и «нет .env.local», и отказ Telegram.
    console.error(`✗ ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(2);
  }
}

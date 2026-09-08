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

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEnv, envPath } from "./env.mjs";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

/** Убирает токен из любого текста, который пойдёт в лог или в текст ошибки. */
function hide(text, token) {
  const s = String(text ?? "").split("\n")[0];
  return token ? s.split(token).join("<токен>") : s;
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
    throw new Error(`ответ Telegram не разобран (HTTP ${res.status})`);
  }
  if (!json?.ok) {
    throw new Error(`Telegram отказал (HTTP ${res.status}): ${json?.description ?? "без текста"}`);
  }
  return json.result;
}

/**
 * Шлёт владельцу одно сообщение обычным текстом (без markdown — в тексте бывают @ и _,
 * и разметка на них ломается вместе с сообщением).
 * Отдаёт `true`, если Telegram принял; `false` — если не настроено или не дошло.
 * Исключений не бросает: звонок владельцу не имеет права свалить обход.
 */
export async function sendTelegram(text, { log = console.log } = {}) {
  const { telegramToken, telegramChatId } = loadEnv();
  if (!telegramToken || !telegramChatId) {
    log("Telegram не настроен, сообщение не ушло");
    log(text);
    return false;
  }
  try {
    await callApi(telegramToken, "sendMessage", { chat_id: telegramChatId, text });
    return true;
  } catch (e) {
    log(`Telegram: сообщение не ушло — ${hide(e?.message ?? e, telegramToken)}`);
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
  if (!telegramToken) throw new Error(`в ${envPath} пусто TELEGRAM_BOT_TOKEN — токен даёт @BotFather`);
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
  log(`боту ещё никто не писал: напиши ему любое сообщение и повтори (обновлений в очереди: ${updates?.length ?? 0})`);
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
      console.log("node telegram.mjs --test            послать пробное сообщение");
      console.log("node telegram.mjs --chat-id [--save] узнать id чата (и вписать в ../.env.local)");
      process.exit(0);
    }

    const { telegramToken, telegramChatId } = loadEnv();
    if (!telegramToken) {
      console.error(`✗ в ${envPath} пусто TELEGRAM_BOT_TOKEN — токен даёт @BotFather`);
      process.exit(2);
    }

    if (has("--chat-id")) {
      const chat = await findChat();
      if (!chat) process.exit(1);
      console.log(`chat id: ${chat.id}${chat.name ? `, ${chat.name}` : ""}${chat.username ? `, @${chat.username}` : ""}`);
      if (has("--save")) {
        saveChatId(chat.id);
        console.log(`✓ вписан в TELEGRAM_CHAT_ID в ${envPath}`);
      } else {
        console.log("чтобы вписать в .env.local, повтори с --save");
      }
      process.exit(0);
    }

    if (has("--test")) {
      if (!telegramChatId) {
        console.error(`✗ в ${envPath} пусто TELEGRAM_CHAT_ID — напиши боту любое сообщение и запусти: node telegram.mjs --chat-id --save`);
        process.exit(2);
      }
      const ok = await sendTelegram("Amestat: пробное сообщение от сборщика. Если оно пришло — сигнал о неудачном обходе тоже дойдёт.");
      console.log(ok ? "✓ отправлено" : "✗ не отправилось");
      process.exit(ok ? 0 : 1);
    }

    console.error(`✗ непонятный ключ: ${argv.join(" ")}. Есть --test и --chat-id [--save]`);
    process.exit(2);
  } catch (e) {
    // Понятная строка вместо стека: сюда попадает и «нет .env.local», и отказ Telegram.
    console.error(`✗ ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(2);
  }
}

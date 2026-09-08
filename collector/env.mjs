// Настройки сборщика. Единственный источник — `../.env.local` (тот же файл, что у сайта).
//
// Ключи никуда не копируются: ни в логи, ни в отчёты, ни в переменные процесса детей.
// Обязательных два — адрес проекта и service_role; без них сборщик не запускается вовсе.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const collectorDir = dirname(fileURLToPath(import.meta.url));
export const envPath = resolve(collectorDir, "..", ".env.local");

// Разбор .env: строка `ИМЯ=значение`, комментарии с # пропускаются, кавычки по краям снимаются.
function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

let cached = null;

/**
 * Читает `../.env.local` и отдаёт настройки сборщика.
 * Бросает Error с русским текстом, если файла нет или пусто обязательное.
 */
export function loadEnv() {
  if (cached) return cached;
  if (!existsSync(envPath)) {
    throw new Error(`нет файла ${envPath} — скопируй .env.local.example в .env.local и заполни`);
  }
  const raw = parseEnvFile(envPath);

  const supabaseUrl = (raw.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/(rest\/v1\/?)?$/, "");
  if (!supabaseUrl) throw new Error(`в ${envPath} пусто NEXT_PUBLIC_SUPABASE_URL — адрес проекта Supabase обязателен`);
  const serviceKey = raw.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!serviceKey) throw new Error(`в ${envPath} пусто SUPABASE_SERVICE_ROLE_KEY — сборщик пишет в базу только этим ключом`);

  // Пауза между креаторами: TikTok не любит очередь запусков подряд. По умолчанию 20 с.
  const pauseRaw = (raw.AMESTAT_PAUSE_S || "").trim();
  const pauseS = pauseRaw === "" ? NaN : Number(pauseRaw);
  const pauseMs = Number.isFinite(pauseS) && pauseS >= 0 ? Math.round(pauseS * 1000) : 20_000;

  // Через сколько повторять неудачный обход по расписанию. По умолчанию 60 минут.
  const retryRaw = (raw.AMESTAT_RETRY_MIN || "").trim();
  const retryMin = retryRaw === "" ? NaN : Number(retryRaw);
  const retryMs = Number.isFinite(retryMin) && retryMin > 0 ? Math.round(retryMin * 60_000) : 60 * 60_000;

  // Комментарии: за сколько последних дней брать видео. По умолчанию 7.
  // Шаг и без того долгий — страница на каждое видео, — а старые обсуждения уже не растут.
  const commentsDaysRaw = (raw.AMESTAT_COMMENTS_DAYS || "").trim();
  const commentsDaysNum = commentsDaysRaw === "" ? NaN : Number(commentsDaysRaw);
  const commentsDays = Number.isFinite(commentsDaysNum) && commentsDaysNum > 0 ? Math.round(commentsDaysNum) : 7;

  // Потолок комментариев на одно видео. По умолчанию 100.
  const commentsMaxRaw = (raw.AMESTAT_COMMENTS_MAX || "").trim();
  const commentsMaxNum = commentsMaxRaw === "" ? NaN : Number(commentsMaxRaw);
  const commentsMax = Number.isFinite(commentsMaxNum) && commentsMaxNum > 0 ? Math.round(commentsMaxNum) : 100;

  // Instagram: пусто — Graph API, если есть токен; иначе браузер (пока заглушка).
  const igToken = raw.IG_ACCESS_TOKEN || "";
  const igUserId = raw.IG_USER_ID || "";
  const igSourceRaw = (raw.IG_SOURCE || "").toLowerCase();
  const igSource = igSourceRaw === "graph" || igSourceRaw === "web" ? igSourceRaw : igToken ? "graph" : "web";

  cached = {
    supabaseUrl,
    serviceKey,
    // Пусто — Opera, если установлена, иначе Chrome. Либо `opera` / `chrome` / полный путь к exe.
    browser: raw.AMESTAT_BROWSER || "",
    pauseMs,
    retryMs,
    commentsDays,
    commentsMax,
    igToken,
    igUserId,
    igSource,
    // Telegram: одно сообщение владельцу, если и повтор через час не удался.
    // Пустой chatId — не беда: сборщик пишет текст в лог и идёт дальше (владелец ещё не писал боту).
    telegramToken: raw.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: raw.TELEGRAM_CHAT_ID || "",
  };
  return cached;
}

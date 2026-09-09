// Настройки сборщика. Единственный источник — `../.env.local` (тот же файл, что у сайта).
//
// Ключи никуда не копируются: ни в логи, ни в отчёты, ни в переменные процесса детей.
// Обязательных два — адрес проекта и service_role; без них сборщик не запускается вовсе.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Разбор часов расписания живёт среди чистых функций расписания — там его и проверяют тесты.
// ⚠️ `schedule.mjs` сюда НЕ импортируется обратно: часы уходят к нему параметром, и кольца нет.
import { parseSlots } from "./schedule.mjs";

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

  // Пауза между креаторами TikTok — между запусками чистых профилей: TikTok не любит очередь
  // запусков подряд. По умолчанию 8 с (было 20; владелец, 2026-09-08 — обход и без того длинный,
  // а пустых списков на восьми секундах не видно). После креатора Instagram и после неудачи
  // «профиль не найден» паузы нет вовсе: там ждать нечего и некого.
  // ⚠️ Если TikTok начнёт отвечать пустыми списками — это скажет замечание `[list]`, и вот тогда
  // паузу стоит вернуть побольше.
  const pauseRaw = (raw.AMESTAT_PAUSE_S || "").trim();
  const pauseS = pauseRaw === "" ? NaN : Number(pauseRaw);
  const pauseMs = Number.isFinite(pauseS) && pauseS >= 0 ? Math.round(pauseS * 1000) : 8_000;

  // Через сколько повторять неудачный обход по расписанию. По умолчанию 60 минут.
  const retryRaw = (raw.AMESTAT_RETRY_MIN || "").trim();
  const retryMin = retryRaw === "" ? NaN : Number(retryRaw);
  const retryMs = Number.isFinite(retryMin) && retryMin > 0 ? Math.round(retryMin * 60_000) : 60 * 60_000;

  // Часы автоматических обходов. Пусто — один слот, 13:00 (владелец, 2026-09-09: обход «всё»
  // занимал 14 минут и трижды в день гонял браузер к каждому креатору). Формат — `13` или
  // `10,13,17`. Разбор — чистая функция `parseSlots` в `schedule.mjs`, чтобы её проверяли тесты.
  const slotHours = parseSlots(raw.AMESTAT_SLOTS);

  // Глубина автоматического обхода: 'all' (по умолчанию) — весь список видео, 'week' — только
  // за последние 7 дней. Владелец, 2026-09-09: «в ежедневном обновлении пусть всё обновляется».
  // ⚠️ Именно этой переменной ставится «неделя», если обход по всему списку окажется долгим.
  const slotDepthRaw = (raw.AMESTAT_SLOT_DEPTH || "").trim().toLowerCase();
  const slotDepth = slotDepthRaw === "week" ? "week" : "all";

  // Защита TikTok по адресу: сколько запусков ЧИСТОГО профиля разрешено за скользящее окно.
  // Пусто — 6 запусков за 15 минут. Счёт общий на все процессы (файл `logs/tiktok-launches.json`).
  const ttLaunchesRaw = (raw.AMESTAT_TT_LAUNCHES || "").trim();
  const ttLaunchesNum = ttLaunchesRaw === "" ? NaN : Number(ttLaunchesRaw);
  const ttLaunchLimit = Number.isFinite(ttLaunchesNum) && ttLaunchesNum > 0 ? Math.round(ttLaunchesNum) : 6;

  const ttWindowRaw = (raw.AMESTAT_TT_WINDOW_MIN || "").trim();
  const ttWindowNum = ttWindowRaw === "" ? NaN : Number(ttWindowRaw);
  const ttWindowMs = Number.isFinite(ttWindowNum) && ttWindowNum > 0 ? Math.round(ttWindowNum * 60_000) : 15 * 60_000;

  // Через сколько минут сам собой повторяется РУЧНОЙ обход, который свалила защита TikTok по
  // адресу. Пусто — 25 минут. Повтор один, письма при назначении нет.
  const manualRetryRaw = (raw.AMESTAT_MANUAL_RETRY_MIN || "").trim();
  const manualRetryNum = manualRetryRaw === "" ? NaN : Number(manualRetryRaw);
  const manualRetryMin = Number.isFinite(manualRetryNum) && manualRetryNum > 0 ? Math.round(manualRetryNum) : 25;

  // Комментарии: за сколько последних дней брать видео. По умолчанию 7.
  // Шаг и без того долгий — страница на каждое видео, — а старые обсуждения уже не растут.
  const commentsDaysRaw = (raw.AMESTAT_COMMENTS_DAYS || "").trim();
  const commentsDaysNum = commentsDaysRaw === "" ? NaN : Number(commentsDaysRaw);
  const commentsDays = Number.isFinite(commentsDaysNum) && commentsDaysNum > 0 ? Math.round(commentsDaysNum) : 7;

  // Потолок комментариев на одно видео. По умолчанию 100.
  const commentsMaxRaw = (raw.AMESTAT_COMMENTS_MAX || "").trim();
  const commentsMaxNum = commentsMaxRaw === "" ? NaN : Number(commentsMaxRaw);
  const commentsMax = Number.isFinite(commentsMaxNum) && commentsMaxNum > 0 ? Math.round(commentsMaxNum) : 100;

  // Потолок ответов под ОДНИМ корневым комментарием. По умолчанию 20.
  // Ветка раскрывается кликом и своим запросом, поэтому потолок здесь свой, а не общий с корневыми.
  const repliesMaxRaw = (raw.AMESTAT_REPLIES_MAX || "").trim();
  const repliesMaxNum = repliesMaxRaw === "" ? NaN : Number(repliesMaxRaw);
  const repliesMax = Number.isFinite(repliesMaxNum) && repliesMaxNum > 0 ? Math.round(repliesMaxNum) : 20;

  // Охват «только наши»: сколько прокруток списка отпущено на поиск отслеживаемых видео
  // (наших и жёлтых). Пусто — 30. Дошли до потолка — остальные отслеживаемые считаются
  // ненайденными: строка в лог и замечание `[list]`. При охвате «всё» переменная не при чём.
  const oursPagesRaw = (raw.AMESTAT_OURS_MAX_PAGES || "").trim();
  const oursPagesNum = oursPagesRaw === "" ? NaN : Number(oursPagesRaw);
  const oursMaxPages = Number.isFinite(oursPagesNum) && oursPagesNum > 0 ? Math.round(oursPagesNum) : 30;

  // Какие коды замечаний НЕ слать в Telegram: список через запятую. Пусто — не глушить ничего.
  const notifyMute = (raw.AMESTAT_NOTIFY_MUTE || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

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
    slotHours,
    slotDepth,
    ttLaunchLimit,
    ttWindowMs,
    manualRetryMin,
    commentsDays,
    commentsMax,
    repliesMax,
    oursMaxPages,
    notifyMute,
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

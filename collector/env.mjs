// Настройки сборщика. Единственный источник — `../.env.local` (тот же файл, что у сайта).
//
// Ключи никуда не копируются: ни в логи, ни в отчёты, ни в переменные процесса детей.
// Обязательных два — адрес проекта и service_role; без них сборщик не запускается вовсе.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Разбор часов расписания живёт среди чистых функций расписания — там его и проверяют тесты.
// ⚠️ `schedule.mjs` сюда НЕ импортируется обратно: часы уходят к нему параметром, и кольца нет.
import { parseSlots, zoneOf } from "./schedule.mjs";
// Разбор списка прокси — там же, где живёт весь пул. ⚠️ `proxies.mjs` сюда не импортируется
// обратно (свою папку он считает от `import.meta.url`), поэтому кольца нет и здесь.
import { parseProxies, addressList } from "./proxies.mjs";

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

  // Часы автоматических обходов. Пусто — один слот, 16:00 (владелец, 2026-09-10: утренний слот
  // выключен совсем — утренний срез теперь даёт первый обход дня от старта компьютера). Формат
  // — `16` или `10,13,17`; у владельца стоит `16`. Читаются они в зоне `AMESTAT_SLOT_TZ` (ниже).
  // Разбор — чистая функция `parseSlots` в `schedule.mjs`, чтобы её проверяли тесты.
  const slotHours = parseSlots(raw.AMESTAT_SLOTS);

  // Зона, в которой читаются часы слотов: имя IANA (`Europe/Warsaw`). Пусто — зона машины,
  // как было всегда. Владелец, 2026-09-09: слоты 7:00 и 16:00 по UTC+2 «с учётом перехода на
  // зимнее время» — числом смещение задать нельзя, оно живёт полгода; зона держит час по
  // стенным часам и меняет смещение сама. Незнакомое имя — не молчим: строка в лог резидента.
  const slotTzRaw = (raw.AMESTAT_SLOT_TZ || "").trim();
  const slotTz = zoneOf(slotTzRaw);
  const slotTzNote = slotTzRaw !== "" && slotTz === null
    ? `неизвестная зона «${slotTzRaw}» — слоты идут по времени машины`
    : null;

  // Глубина автоматического обхода: 'all' (по умолчанию) — весь список видео, 'week' — 7 дней,
  // 'month' — 30 (миграция v18). Владелец, 2026-09-09: «в ежедневном обновлении пусть всё
  // обновляется». ⚠️ Именно этой переменной глубина уменьшается, если обход по всему списку
  // окажется долгим.
  // 🔴 'range' слоту НЕ разрешается: расписание идёт каждый день, а период — это срез за
  // конкретные числа, и завтра он был бы тем же самым. Написали — опускаем до 'all' и говорим
  // об этом строкой в лог резидента (`slotDepthNote`), а не молча.
  const slotDepthRaw = (raw.AMESTAT_SLOT_DEPTH || "").trim().toLowerCase();
  const slotDepthOk = ["all", "week", "month"].includes(slotDepthRaw);
  const slotDepth = slotDepthOk ? slotDepthRaw : "all";
  const slotDepthNote = slotDepthRaw === "" || slotDepthOk
    ? null
    : slotDepthRaw === "range"
      ? "«период» расписанию не годится (он про конкретные числа) — слот, догон и повтор идут с «всё»"
      : `неизвестная глубина «${slotDepthRaw}» — слот, догон и повтор идут с «всё»`;

  // Защита TikTok по адресу: сколько запусков ЧИСТОГО профиля разрешено за скользящее окно.
  // Пусто — 6 запусков за 15 минут. Счёт общий на все процессы (файл `logs/tiktok-launches.json`).
  const ttLaunchesRaw = (raw.AMESTAT_TT_LAUNCHES || "").trim();
  const ttLaunchesNum = ttLaunchesRaw === "" ? NaN : Number(ttLaunchesRaw);
  const ttLaunchLimit = Number.isFinite(ttLaunchesNum) && ttLaunchesNum > 0 ? Math.round(ttLaunchesNum) : 6;

  const ttWindowRaw = (raw.AMESTAT_TT_WINDOW_MIN || "").trim();
  const ttWindowNum = ttWindowRaw === "" ? NaN : Number(ttWindowRaw);
  const ttWindowMs = Number.isFinite(ttWindowNum) && ttWindowNum > 0 ? Math.round(ttWindowNum * 60_000) : 15 * 60_000;

  // Пул адресов (владелец, 2026-09-09: «если можешь реализовать прокси — прекрасно»). Пусто —
  // прокси нет вовсе и всё как раньше: ходим с домашнего адреса.
  //   AMESTAT_PROXIES            — через запятую: http://user:pass@host:port, https://…, socks5://…
  //   AMESTAT_PROXY_SCOPE        — 'tiktok-list' (пусто — так): прокси только у чистых профилей
  //                                списка TikTok; 'all' — ещё и у браузеров полос.
  //     ⚠️ По умолчанию сессии фейковых аккаунтов остаются на домашнем адресе: смена адреса у
  //     вошедшего аккаунта ловит проверки безопасности площадки.
  //   AMESTAT_PROXY_HOME         — 'on' (пусто — так): домашний адрес идёт в круг как «адрес #0»;
  //                                'off' — только прокси.
  //   AMESTAT_PROXY_COOLDOWN_MIN — пауза адресу, давшему пустой список или ошибку соединения.
  // 🔴 Логин и пароль остаются здесь и в объекте адреса: в логи и в сообщения уходит только
  // подпись вида «прокси #2 host:port».
  const proxies = parseProxies(raw.AMESTAT_PROXIES);
  const proxyScopeRaw = (raw.AMESTAT_PROXY_SCOPE || "").trim().toLowerCase();
  const proxyScope = proxyScopeRaw === "all" ? "all" : "tiktok-list";
  const proxyHome = (raw.AMESTAT_PROXY_HOME || "").trim().toLowerCase() !== "off";
  const proxyAddresses = addressList(proxies, { home: proxyHome });

  const cooldownRaw = (raw.AMESTAT_PROXY_COOLDOWN_MIN || "").trim();
  const cooldownNum = cooldownRaw === "" ? NaN : Number(cooldownRaw);
  const proxyCooldownMs = Number.isFinite(cooldownNum) && cooldownNum > 0 ? Math.round(cooldownNum * 60_000) : 30 * 60_000;

  // У кого проверять список видео командой `npm run proxy-check -- --tiktok`. Пусто — креатор,
  // на котором проверялись все прежние пробы TikTok.
  const proxyCheckHandle = (raw.AMESTAT_PROXY_CHECK_HANDLE || "").trim().replace(/^@/, "") || "toplombard_warszaw";

  // Через сколько минут сам собой повторяется РУЧНОЙ обход, который свалила защита TikTok по
  // адресу. Пусто — 25 минут. Повтор один, письма при назначении нет.
  const manualRetryRaw = (raw.AMESTAT_MANUAL_RETRY_MIN || "").trim();
  const manualRetryNum = manualRetryRaw === "" ? NaN : Number(manualRetryRaw);
  const manualRetryMin = Number.isFinite(manualRetryNum) && manualRetryNum > 0 ? Math.round(manualRetryNum) : 25;

  // Через сколько минут после запуска резидента идёт ПЕРВЫЙ обход дня (владелец, 2026-09-10:
  // «компьютер включился, ~5 минут на разогрев — и обход»). Пусто и мусор — 5; `0` — сразу,
  // без паузы, и это законное значение. Тем же правилом планируется первый обход после сна.
  const startDelayRaw = (raw.AMESTAT_START_DELAY_MIN || "").trim();
  const startDelayNum = startDelayRaw === "" ? NaN : Number(startDelayRaw);
  const startDelayMin = Number.isFinite(startDelayNum) && startDelayNum >= 0 ? Math.round(startDelayNum) : 5;

  // Комментарии: за сколько последних дней брать видео. По умолчанию 7.
  // 🔴 На обход эта переменная больше НЕ влияет (владелец, 2026-09-09): окно шага комментариев
  // равно ГЛУБИНЕ обхода — «неделя» 7 дней, «месяц» 30, «период» сам период, «всё» без
  // ограничения по дате. Прежнее самостоятельное окно означало, что обход за месяц приносил
  // счётчики месячных видео и ни одного текста. Значение остаётся про запас — как отдельное
  // умолчание для расписания, если владелец захочет его завести.
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
    // Зона слотов: имя IANA или null («зона машины»).
    slotTz,
    slotTzNote,
    slotDepth,
    slotDepthNote,
    ttLaunchLimit,
    ttWindowMs,
    // Пул адресов: `proxyAddresses` — готовый список `[{ id, label, server, username, password }]`,
    // id 0 — домашний. Пароли внутри: в лог идёт только `label`.
    proxyAddresses,
    proxyScope,
    proxyHome,
    proxyCooldownMs,
    proxyCheckHandle,
    manualRetryMin,
    // Пауза перед первым обходом дня после старта резидента и после сна, минут (0 — сразу).
    startDelayMin,
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

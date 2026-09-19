// Русский текст писем владельцу в Telegram.
//
// Зачем: владелец, 2026-09-17 — всё, что сборщик шлёт в Telegram, приходит ПО-РУССКИ. Всё
// остальное — лог обхода (`sync_runs.log`, `logs/*.log`), `sync_error`, сайт,
// `notices-state.json` — остаётся английским: логика сборщика ловит беды по английским словам
// (`WARN_RE`, `pauseAfter`/`profileGone`, `ADDRESS_ERROR_RE`), а память повторов (`squashKnown`)
// держит английский текст ключом. Поэтому перевод — последний шаг перед отправкой, и только
// для письма: английский текст пишется в лог как был, русский уходит в телефон.
//
// Как устроено: упорядоченная таблица пар «английский шаблон → русский шаблон». Шаблон
// сравнивается со ВСЕЙ строкой (`^…$`), `{имя}` ловит любой непустой кусок; первая подошедшая
// пара побеждает — поэтому частные шаблоны стоят выше общих. Пойманные куски переводятся той же
// таблицей (внутри бывают вложенные фразы: «обход прерван: <ошибка>», «@ручка: <ошибка>»), не
// глубже 4 уровней. Не подошло ничего — строка уходит как есть: ручки, числа, id и чужие
// системные тексты (`fetch failed`, ошибки Playwright, ответы базы) так и должны проходить.
//
// 🔴 Новая английская фраза, которая может дойти до письма, — новая пара здесь, тем же заходом.
// Тест `telegram-ru.test.mjs` сканирует `notice(…)`, `residentNotice(…)`, `new Error(…)` и
// тексты причин (`why`) и падает на фразе без русской пары.
// ⚠️ Никаких общих шаблонов вида `{a}: {b}` и шаблонов из одного слова: рекурсия начнёт
// «переводить» куски ручек и адресов. Тест проверяет и это.
// ⚠️ Формулировки — прежние русские тексты сборщика (до перевода на английский 2026-09-17) слово
// в слово; новые фразы — в том же стиле.

import { depthLabel, depthWord } from "./scope.mjs";

const MAX_DEPTH = 4;   // вложенность фраз: «обход прерван: @ручка: браузер не запустился: …»

// Порядок важен: сверху частное, снизу общее. Внутри — по модулям, откуда фраза приходит.
export const PAIRS = [
  // ---------------------------------------------------------------- notices.mjs
  ["{count} more creators with the same old errors (see earlier messages)", "ещё {count} креаторов с прежними ошибками (см. прошлые письма)"],
  ["{count} more old notices, all the same (see earlier messages)", "ещё {count} прежних замечаний, всё те же (см. прошлые письма)"],
  ["{where}: the login cookie expires in {days} d — log in to Opera again and take a fresh profile copy", "{where}: cookie входа истекает через {days} дн. — войди в Opera заново и сними копию профиля"],
  ["{where}: the login has not been renewed for {days} d — the platform seems to no longer treat us as logged in", "{where}: вход не продлевался {days} дн. — похоже, площадка больше не считает нас вошедшими"],
  ["@{handle}: not found in the profile, looks deleted — {count} videos from {dates}; links are in the run log, I will not report these videos again", "@{handle}: нет в профиле, похоже, удалены — {count} видео от {dates}; ссылки в логе обхода, об этих видео больше не пишу"],

  // ---------------------------------------------------------------- scope.mjs (`shortfall`)
  ["empty list: not a single video came back ({counts})", "список пуст: не пришло ни одного видео ({counts})"],
  ["list ended at {count} videos, but the profile says {total}", "список кончился на {count} видео, а по профилю {total}"],
  ["in DB {count}, profile says {total}", "в базе {count}, по профилю {total}"],
  ["in DB {count}", "в базе {count}"],
  ["profile says {total}", "по профилю {total}"],

  // ---------------------------------------------------------------- sync.mjs
  ["the \"gone\" mark on videos was not written: {error}", "отметка «удалено» у видео не записалась: {error}"],
  ["the \"gone\" mark on videos was not cleared: {error}", "отметка «удалено» у видео не снялась: {error}"],
  ["@{handle}: the \"profile gone\" mark was not written — {error}", "@{handle}: отметка «профиль удалён» не записалась — {error}"],
  ["the tracked videos could not be read: {error}", "отслеживаемые видео не спросились: {error}"],
  ["the previous videos could not be counted: {error}", "прежние видео не посчитались: {error}"],
  ["the previous videos could not be read — the vanished ones were not checked: {error}", "прежние видео не спросились — пропавшие не проверены: {error}"],
  ["the previous covers could not be read: {error}", "прежние обложки не спросились: {error}"],
  ["the previous comment counts could not be read: {error}", "прежние числа комментариев не спросились: {error}"],
  ["@{handle}: the browser for comments did not start — {error}", "@{handle}: браузер для комментариев не поднялся — {error}"],
  ["@{handle}: the direct request gave nothing on {count} of {total} videos — {why}", "@{handle}: прямой запрос не дал на {count} видео из {total} — {why}"],
  ["branches did not return ({count} of {total})", "ветки не отдались ({count} из {total})"],
  ["anchor: {why}", "якорь: {why}"],
  ["the run did not start: {error}", "обход не начался: {error}"],
  ["the requests were not marked as taken: {error}", "просьбы не помечены взятыми: {error}"],
  ["@{handle}: the creator error was not written either — {error}", "@{handle}: не записалась и ошибка креатора — {error}"],
  ["@{handle}: took {minutes} min to collect", "@{handle}: собирался {minutes} мин"],
  ["the run was interrupted: {error}", "обход прерван: {error}"],
  ["the result of run #{run} was not written: {error}", "итог обхода #{run} не записался: {error}"],
  ["unknown platform: {platform}", "неизвестная площадка: {platform}"],
  ["@{handle} video {id}: {error}", "@{handle} видео {id}: {error}"],

  // ---------------------------------------------------------------- watch.mjs
  ["{what} failing {count} times in a row: {error}", "{what} не выходит {count} раз подряд: {error}"],
  ["{what}: the database connection is back", "{what}: связь с базой вернулась"],
  ["marking requests as seen", "отметка просьб принятыми"],
  ["checking today's run", "проверка сегодняшнего обхода"],
  ["polling for requests", "опрос просьб"],
  ["the retry crashed: {error}", "повтор сорвался: {error}"],
  ["the run for slot {slot} failed — a retry is scheduled for {time}", "обход слота {slot} не удался — повтор назначен на {time}"],
  ["the first run of the day crashed: {error}", "первый обход дня сорвался: {error}"],
  ["Opera windows on our profiles killed at startup: {count}", "при старте добито окон Opera на наших профилях: {count}"],
  ["the scheduled run crashed: {error}", "обход по расписанию сорвался: {error}"],
  ["Realtime is back, the gap was {minutes} min — requests are caught by the subscription again", "Realtime вернулся, перерыв {minutes} мин — просьбы снова ловлю подпиской"],
  ["Realtime has been down since {time}, requests are caught by the once-a-minute poll", "Realtime не работает с {time}, просьбы ловлю опросом раз в минуту"],
  ["the request queue crashed: {error}", "очередь просьб сорвалась: {error}"],
  ["request #{id} was caught by the poll, not by Realtime (first poll at startup)", "просьба #{id} поймана опросом, а не Realtime (первый опрос при старте)"],
  ["request #{id} was caught by the poll, not by Realtime", "просьба #{id} поймана опросом, а не Realtime"],
  ["the retry was not restored: {error}", "повтор не восстановлен: {error}"],
  ["{time} (manual request)", "{time} (ручная просьба)"],

  // ---------------------------------------------------------------- tiktok.mjs
  ["@{handle}: TikTok stop screen on the profile page", "@{handle}: стоп-экран TikTok на странице профиля"],
  ["@{handle}: TikTok stop screen", "@{handle}: стоп-экран TikTok"],
  ["@{handle}: {count} of our/yellow videos not found over {pages} scrolls (scope \"ours only\")", "@{handle}: не найдено {count} наших/жёлтых видео за {pages} прокруток (охват «только наши»)"],
  ["profile page @{handle} did not open: {error}", "страница профиля @{handle} не открылась: {error}"],
  ["TikTok stop screen on profile @{handle}", "стоп-экран TikTok на профиле @{handle}"],
  ["profile not found: @{handle}", "профиль не найден: @{handle}"],
  ["run for @{handle} cancelled: no free address", "обход @{handle} отменён: свободного адреса нет"],
  ["TikTok stop screen at @{handle}", "стоп-экран TikTok у @{handle}"],
  ["TikTok returned no list ({where}; profile says {count} videos): @{handle}", "TikTok не отдал список ({where}; по профилю {count} видео): @{handle}"],
  ["TikTok returned no list ({where}; profile says {count} videos)", "TikTok не отдал список ({where}; по профилю {count} видео)"],
  ["address throttling: {addresses}", "защита по адресу: {addresses}"],
  ["address throttling", "защита по адресу"],
  ["creator has an empty handle", "у креатора пустой handle"],

  // ---------------------------------------------------------------- instagram-web.mjs
  ["@{handle}: the Reels tab did not open — there will be no view counts ({error})", "@{handle}: вкладка Reels не открылась — просмотров не будет ({error})"],
  ["@{handle}: the Instagram list via direct request gave nothing — {why}", "@{handle}: прямой запрос списка Instagram не дал ничего — {why}"],
  ["@{handle}: login not confirmed (login wall={wall}, login_required={required}, cookie sessionid=no)", "@{handle}: вход не подтвердился (стена входа={wall}, login_required={required}, cookie sessionid=нет)"],
  ["@{handle}: login not confirmed (login wall={wall}, login_required={required}, cookie sessionid=yes)", "@{handle}: вход не подтвердился (стена входа={wall}, login_required={required}, cookie sessionid=есть)"],
  ["@{handle}: nothing collected after scrolling, login not confirmed", "@{handle}: после прокрутки не собралось ничего, вход не подтверждён"],
  ["@{handle}: Instagram rate-limited the requests (the feed is empty)", "@{handle}: Instagram ограничил запросы (лента пуста)"],
  ["Instagram: the fake account session has expired — log in again in Opera and take a fresh profile copy", "Instagram: сессия фейкового аккаунта истекла — войди в Opera заново и сними копию профиля"],
  ["Instagram: the platform rate-limited the requests, try later", "Instagram: площадка ограничила запросы, попробуй позже"],
  ["Instagram: the feed is empty while the profile lists {count} posts: @{handle}", "Instagram: лента пуста при {count} публикациях по профилю: @{handle}"],
  ["Instagram: profile page @{handle} did not open: {error}", "Instagram: страница профиля @{handle} не открылась: {error}"],
  ["Instagram: profile not found: @{handle}", "Instagram: профиль не найден: @{handle}"],
  ["Instagram: private profile: @{handle}", "Instagram: закрытый профиль: @{handle}"],
  // Номер страницы прямого пути (`listDirect`) дописан хвостом к причине — снимается раньше
  // «feed: …», иначе хвост уехал бы внутрь причины и не перевёлся.
  ["{why} (page {page})", "{why} (страница {page})"],
  ["feed: the response has no feed", "лента: в ответе нет ленты"],
  ["feed: the response holds someone else's posts", "лента: в ответе чужие публикации"],
  ["feed: {why}", "лента: {why}"],
  ["profile: id not found ({why})", "профиль: id не нашёлся ({why})"],
  ["profile: id not found", "профиль: id не нашёлся"],
  ["profile: the response has no user", "профиль: в ответе нет user"],
  ["profile: id {id} returned @{handle}", "профиль: id {id} отдал @{handle}"],
  ["profile: {why}", "профиль: {why}"],
  ["the feed is empty while the profile lists {count} posts", "лента пуста при {count} публикациях по профилю"],
  ["there is no Reels template yet", "шаблона Reels ещё нет"],
  ["the response has no Reels", "в ответе нет Reels"],

  // ---------------------------------------------------------------- instagram-graph.mjs
  ["Instagram: Graph API response is not JSON (HTTP {status})", "Instagram: ответ Graph API не разобран (HTTP {status})"],
  ["Instagram: Graph API returned HTTP {status}", "Instagram: Graph API ответил HTTP {status}"],
  ["Instagram: profile not found or not a business account: @{handle}", "Instagram: профиль не найден или не бизнес-аккаунт: @{handle}"],
  ["Instagram: no IG_ACCESS_TOKEN — put the token in .env.local or switch IG_SOURCE to web", "Instagram: нет IG_ACCESS_TOKEN — впиши токен в .env.local или переключи IG_SOURCE на web"],
  ["Instagram: no IG_USER_ID — our business account id is required in .env.local", "Instagram: нет IG_USER_ID — нужен id нашего бизнес-аккаунта в .env.local"],
  ["Instagram: Graph API refused ({code}): {error}", "Instagram: Graph API отказал ({code}): {error}"],

  // ---------------------------------------------------------------- instagram-direct.mjs
  ["request failed: no response", "запрос не прошёл: нет ответа"],
  ["request failed: {error}", "запрос не прошёл: {error}"],
  ["anchor is closed", "якорь закрыт"],
  ["redirected to login — the browser will check the session", "перекинуло на вход — сессию проверит браузер"],
  ["Instagram rate-limited the requests (429)", "Instagram ограничил запросы (429)"],
  ["response is not JSON (redirected)", "ответ не JSON (была переадресация)"],
  ["response is not JSON", "ответ не JSON"],
  ["empty response", "пустой ответ"],
  ["refused: {error}", "отказ: {error}"],
  ["no comments in response", "в ответе нет comments"],
  ["no child_comments in response", "в ответе нет child_comments"],
  ["anchor landed on {where} — the browser will check the session", "якорь попал на {where} — сессию проверит браузер"],
  ["anchor did not open: {error}", "якорь не открылся: {error}"],
  ["post has no id", "у публикации нет id"],
  ["no post or comment id", "нет id публикации или комментария"],

  // ---------------------------------------------------------------- direct.mjs (TikTok)
  ["empty body", "пустое тело"],
  ["body is not JSON", "тело не JSON"],
  ["no comments[] in response", "в ответе нет comments[]"],
  ["empty HTML", "пустой HTML"],
  ["no __UNIVERSAL_DATA_FOR_REHYDRATION__ in HTML", "в HTML нет __UNIVERSAL_DATA_FOR_REHYDRATION__"],
  ["page data did not parse", "данные страницы не разобрались"],
  ["no userInfo on the page", "на странице нет userInfo"],
  ["no counters in userInfo", "в userInfo нет счётчиков"],
  ["video has no id", "у видео нет id"],
  ["zero comments while the counter says {count}", "ноль комментариев при счётчике {count}"],
  ["no video or comment id", "нет id видео или комментария"],
  ["empty handle", "пустой handle"],

  // ---------------------------------------------------------------- comments-instagram.mjs
  ["post has no id or url", "у публикации нет id или адреса"],
  ["url does not point to a post: {url}", "адрес не ведёт на публикацию: {url}"],
  ["post page did not open: {error}", "страница публикации не открылась: {error}"],
  ["Instagram: post is unavailable: {url}", "Instagram: публикация недоступна: {url}"],
  ["{who}: login not confirmed (login form={form}, login_required={required})", "{who}: вход не подтвердился (форма входа={form}, login_required={required})"],
  ["{who}: login_required and not a single comment", "{who}: login_required и ни одного комментария"],
  ["{who}: Instagram rate-limited the requests", "{who}: Instagram ограничил запросы"],
  ["{who}: not enough time for branches, opened {count} of {total}", "{who}: на ветки не хватило времени, раскрыто {count} из {total}"],
  ["{who}: no replies collected from any of the {total} branches", "{who}: ответы не снялись ни у одной из {total} веток"],

  // ---------------------------------------------------------------- comments-tiktok.mjs
  ["no post on the page", "поста на странице нет"],
  ["{id}: /video/ did not open ({why}) — going to /photo/", "{id}: /video/ не открылся ({why}) — иду по /photo/"],
  ["{who}: TikTok showed a captcha", "{who}: TikTok показал капчу"],
  ["{profile}: {who} — {count} empty comment responses (has the fake account session in this profile copy expired? is the window hidden?)", "{profile}: {who} — {count} пустых ответов на комментарии (сессия фейка в этой копии профиля истекла? окно скрыто?)"],
  ["video page did not open: {why}; /photo/ either: {error}", "страница видео не открылась: {why}; /photo/ тоже: {error}"],
  ["video page did not open: {why}", "страница видео не открылась: {why}"],
  ["video has no id or url", "у видео нет id или адреса"],
  ["TikTok showed a captcha on video {id}", "TikTok показал капчу на видео {id}"],
  ["TikTok returned {count} empty comment responses for video {id} (profile {profile}: session expired or window hidden)", "TikTok отдал {count} пустых ответов на комментарии видео {id} (профиль {profile}: сессия истекла или окно скрыто)"],
  ["TikTok did not request comments for video {id}: tab did not open, on screen «{screen}»", "TikTok не запросил комментарии видео {id}: вкладка не открылась, на экране «{screen}»"],
  ["TikTok did not request comments for video {id}: tab {tab}, on screen «{screen}»", "TikTok не запросил комментарии видео {id}: вкладка {tab}, на экране «{screen}»"],

  // ---------------------------------------------------------------- browser.mjs
  ["the window watcher did not start: {error}", "сторож окон не поднялся: {error}"],
  ["the browser did not close by itself — had to kill it (fresh profile)", "браузер не закрылся сам — пришлось добить (свежий профиль)"],
  ["the browser did not close by itself — had to kill it ({profile})", "браузер не закрылся сам — пришлось добить ({profile})"],
  ["the fresh profile did not start (address: {address}): {error}", "свежий профиль не поднялся (адрес: {address}): {error}"],
  ["the window may open on top of your work ({profile}): {error}", "окно может открыться поверх работы ({profile}): {error}"],
  ["profile {profile} may restore old tabs: {error}", "профиль {profile} может восстановить старые вкладки: {error}"],
  ["the browser failed to start twice on {profile} (address: {address}): {first}; then {error}", "браузер не запустился дважды на {profile} (адрес: {address}): {first}; потом {error}"],
  ["the browser did not start on the first try on {profile}, retrying: {error}", "браузер не встал с первого раза на {profile}, пробую ещё: {error}"],
  ["profile {profile} restored {count} old tabs — they were closed", "профиль {profile} восстановил {count} старых вкладок — закрыты"],
  ["AMESTAT_BROWSER=opera, but Opera was not found in %LOCALAPPDATA%\\Programs\\Opera", "AMESTAT_BROWSER=opera, но Opera не найдена в %LOCALAPPDATA%\\Programs\\Opera"],
  ["AMESTAT_BROWSER points to a file that does not exist: {file}", "AMESTAT_BROWSER указывает на несуществующий файл: {file}"],
  ["no Opera profile copy ({dir}) — there is nothing to copy from", "нет копии профиля Opera ({dir}) — с неё нечего копировать"],
  ["no Opera profile copy ({dir}) — make one with the fake accounts signed in", "нет копии профиля Opera ({dir}) — сними её с входом фейковых аккаунтов"],
  ["the second profile copy could not be created ({dir}): {error}", "вторая копия профиля не завелась ({dir}): {error}"],
  ["the browser did not start ({browser}, address: {address}): {error}", "браузер не запустился ({browser}, адрес: {address}): {error}"],
  ["the browser failed to start twice ({browser}, {profile}, address: {address}): {first}; then {error}", "браузер не запустился дважды ({browser}, {profile}, адрес: {address}): {first}; потом {error}"],
  ["the profile has no Default/Preferences — the window placement cannot be fixed", "в профиле нет Default/Preferences — расположение окна не поправить"],
  ["Default/Preferences could not be parsed: {error}", "Default/Preferences не разобрался: {error}"],
  ["Default/Preferences could not be written: {error}", "Default/Preferences не записался: {error}"],
  ["Default/Preferences could not be updated: {error}", "Default/Preferences не поправился: {error}"],
  ["Default/Sessions could not be cleared: {error}", "Default/Sessions не стёрлись: {error}"],

  // ---------------------------------------------------------------- proxies.mjs (ярлыки адресов)
  ["proxy #{number} {host}", "прокси #{number} {host}"],
  ["address #{number}", "адрес #{number}"],

  // ---------------------------------------------------------------- images.mjs
  ["{path}: download failed — {error}", "{path}: не скачалась — {error}"],
  ["{path}: upload failed — {error}", "{path}: не залилась — {error}"],
  ["not an image (type not stated)", "не картинка (тип не назван)"],
  ["not an image ({type})", "не картинка ({type})"],
  ["{size} KB — over the limit", "{size} КБ — больше потолка"],
  ["over {size} MB — skipped", "больше {size} МБ — не берём"],
  ["no response in {seconds} s", "не ответил за {seconds} с"],

  // ---------------------------------------------------------------- radmin.mjs
  ["Radmin not turned off: task \"{task}\" did not start ({error})", "Radmin не выключен: задача «{task}» не запустилась ({error})"],
  ["Radmin did not shut down within {seconds} s (service {service}, adapter {adapter}) — the run goes ahead as is", "Radmin не погас за {seconds} с (служба {service}, адаптер {adapter}) — обход идёт как есть"],
  ["Radmin is off, but the browser never came online after {count} tries — the run goes ahead as is", "Radmin выключен, но браузер так и не вышел в сеть за {count} попыток — обход идёт как есть"],

  // ---------------------------------------------------------------- env.mjs (обход не начался)
  ["no file {path} — copy .env.local.example to .env.local and fill it in", "нет файла {path} — скопируй .env.local.example в .env.local и заполни"],
  ["NEXT_PUBLIC_SUPABASE_URL is empty in {path} — the Supabase project address is required", "в {path} пусто NEXT_PUBLIC_SUPABASE_URL — адрес проекта Supabase обязателен"],
  ["SUPABASE_SERVICE_ROLE_KEY is empty in {path} — the collector writes to the database only with this key", "в {path} пусто SUPABASE_SERVICE_ROLE_KEY — сборщик пишет в базу только этим ключом"],

  // ---------------------------------------------------------------- общие формы — строго последними
  // Переходники: сами слов не добавляют, но переводят вложенную ошибку.
  ["Instagram: {error}", "Instagram: {error}"],
  ["@{handle}: {error}", "@{handle}: {error}"],
];

// Формы, которые годятся только ДЛЯ СВОЕГО МЕСТА шаблона, а не для любой строки: « video »
// встречается в десятке английских фраз, и общий шаблон `{handle} video {id}` испортил бы их.
// Место с таким именем переводится своим списком (см. `VALUE_RU`).
const WHO_PAIRS = [
  ["{handle} video {id}", "{handle} видео {id}"],
  ["{handle} post {id}", "{handle} публикация {id}"],
];
const DATES_PAIRS = [
  ["{dates} and {count} more", "{dates} и ещё {count}"],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Английский шаблон → якорный regex и имена мест. Ошибку в таблице видно сразу при загрузке. */
function compile([en, ru]) {
  const names = [];
  let source = "^";
  let last = 0;
  for (const m of en.matchAll(/\{(\w+)\}/g)) {
    source += `${escapeRe(en.slice(last, m.index))}(.+?)`;
    names.push(m[1]);
    last = m.index + m[0].length;
  }
  source += `${escapeRe(en.slice(last))}$`;
  const ruNames = [...ru.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (new Set(names).size !== names.length) throw new Error(`telegram-ru: repeated placeholder in "${en}"`);
  if (ruNames.length !== names.length || ruNames.some((n) => !names.includes(n))) {
    throw new Error(`telegram-ru: placeholders differ between "${en}" and "${ru}"`);
  }
  return { en, ru, names, re: new RegExp(source, "s") };
}

const COMPILED = PAIRS.map(compile);
const WHO = WHO_PAIRS.map(compile);
const DATES = DATES_PAIRS.map(compile);

/** Первая подошедшая пара списка; пойманные куски — дальше по `VALUE_RU` или общей таблицей. */
function translate(list, text, depth) {
  const s = String(text ?? "");
  for (const pair of list) {
    const m = pair.re.exec(s);
    if (!m) continue;
    const values = {};
    pair.names.forEach((name, i) => {
      const raw = m[i + 1];
      if (depth >= MAX_DEPTH) values[name] = raw;
      else values[name] = (VALUE_RU[name] ?? toRussian)(raw, depth + 1);
    });
    // Функцией, а не строкой замены: `$` в значении не должен значить ничего.
    return pair.ru.replace(/\{(\w+)\}/g, (_, name) => values[name]);
  }
  return s;
}

/**
 * Одна английская фраза (текст замечания, текст ошибки) — по-русски.
 * Незнакомое возвращается как есть. Пойманные куски переводятся той же таблицей, пока глубина
 * не больше `MAX_DEPTH`. Чистая функция: её проверяют тесты.
 */
export function toRussian(text, depth = 0) {
  return translate(COMPILED, text, depth);
}

// Ярлык адреса пула (`proxies.mjs`) или их список через запятую. «home» — своим словарём, а не
// парой таблицы: однословный шаблон рекурсия применила бы и к ручке `@home`.
function addressRu(value, depth) {
  return String(value).split(", ").map((one) => (one === "home" ? "домашний" : toRussian(one, depth))).join(", ");
}

// Места шаблонов со своим переводом. Остальные места переводятся общей таблицей.
const VALUE_RU = {
  address: addressRu,
  addresses: addressRu,
  who: (value, depth) => translate(WHO, value, depth),
  dates: (value, depth) => translate(DATES, value, depth),
};

// ------------------------------------------------------------------ заголовки и хвосты писем

const DEPTH_RU = { all: "всё", week: "неделя", month: "месяц", range: "период" };

/**
 * Глубина словом по-русски: «всё», «неделя», «месяц», «период 01.09–09.09».
 * Края периода считает `depthLabel` из `scope.mjs` — здесь меняется только слово, чтобы даты
 * не считались в двух местах. Чистая функция.
 */
export function depthLabelRu(depth, from = null, to = null) {
  const word = depthWord(depth);
  return `${DEPTH_RU[word] ?? word}${depthLabel(depth, from, to).slice(word.length)}`;
}

/**
 * Заголовок письма обхода. `trigger` остаётся латиницей, как было всегда; `slotLabel` —
 * «HH:MM» или «HH:MM (manual request)», переводится таблицей. Чистая функция.
 */
export function runHeadRu({ runId = null, trigger = "manual", depth = "all", depthFrom = null, depthTo = null, done = 0, failed = 0, slotLabel = null } = {}) {
  return `Amestat, обход #${runId ?? "?"} (${trigger}, ${depthLabelRu(depth, depthFrom, depthTo)}): собрано ${done}, с ошибкой ${failed}`
    + (slotLabel ? `\nвторая неудача подряд после слота ${toRussian(slotLabel)}` : "");
}

/** Заголовок письма резидента. */
export function residentHeadRu(total) {
  return `Amestat, резидент: замечаний ${total}`;
}

/** Хвост письма, когда замечания не влезли: «… и ещё K». */
export const moreRu = (k) => `… и ещё ${k}`;

/** Замечания для письма: код остаётся латиницей (по нему глушат `AMESTAT_NOTIFY_MUTE`), текст — по-русски. */
export function itemsRu(items) {
  return (items ?? []).map((i) => ({ ...i, text: toRussian(i.text) }));
}

/** Письмо резидента, когда повтор обхода не смог даже начаться (`watch.mjs`, `callOwner`). */
export function retryFailedRu({ slotLabel, retryLabel, error }) {
  return [
    `Amestat: повтор обхода не смог начаться. Слот ${toRussian(slotLabel)}, повтор ${retryLabel}.`,
    `База не ответила: ${toRussian(error)}`,
    "Строки в sync_runs нет — на сайте этого тоже не видно.",
  ].join("\n");
}

/** Пробное сообщение `node telegram.mjs --test`. */
export const TEST_MESSAGE_RU = "Amestat: пробное сообщение от сборщика. Если оно пришло — сигнал о неудачном обходе тоже дойдёт.";

/**
 * Утренняя пачка: письма, придержанные ночью (`telegram.mjs`, владелец 2026-09-19: «чтобы они
 * собирались и в 7:00 утра все отправлялись разом»). У каждого письма — время, когда оно
 * родилось, по Минску.
 *
 * Отдаёт части не длиннее `max` (у Telegram потолок 4096 символов) вместе с числом писем в
 * каждой: не дошла часть — в очереди остаются только её письма и следующие. Письмо длиннее
 * части обрезается с «…» — длиннее `MAX_CHARS` обхода они и так не бывают.
 * Чистая: часы ночи и пояс приходят параметрами, из `telegram.mjs`.
 */
export function nightDigestRu(items, { from = 23, to = 7, tz = "Europe/Minsk", max = 3500 } = {}) {
  const list = (items ?? []).filter((i) => typeof i?.text === "string");
  if (list.length === 0) return [];
  const clock = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const pad = (h) => String(h).padStart(2, "0");
  const head = `Amestat: за ночь (${pad(from)}:00–${pad(to)}:00) накопилось сообщений: ${list.length}`;
  const more = "Amestat: сообщения за ночь, продолжение";
  const parts = [];
  let text = head;
  let count = 0;
  for (const item of list) {
    const at = Number.isFinite(Date.parse(item.at)) ? clock.format(new Date(item.at)) : "--:--";
    let entry = `${at}\n${item.text}`;
    const room = max - more.length - 2;
    if (entry.length > room) entry = `${entry.slice(0, room - 1)}…`;
    if (count > 0 && text.length + 2 + entry.length > max) {
      parts.push({ text, count });
      text = more;
      count = 0;
    }
    text += `\n\n${entry}`;
    count += 1;
  }
  parts.push({ text, count });
  return parts;
}

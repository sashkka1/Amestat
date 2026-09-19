// Русские письма в Telegram (`telegram-ru.mjs`): таблица переводов, её покрытие и заголовки.
//
// Главное здесь — тест покрытия: он читает исходники сборщика, достаёт английские фразы, которые
// могут дойти до письма (`notice(…)`, `residentNotice(…)`, `new Error(…)`, причины `why` и
// тексты, собранные в переменную), подставляет вместо `${…}` образцы `X1`, `X2`… и требует, чтобы
// `toRussian` дал русский текст без английских слов. Новая фраза без русской пары валит тесты.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAIRS, toRussian, depthLabelRu, runHeadRu, residentHeadRu, moreRu, itemsRu, retryFailedRu, TEST_MESSAGE_RU,
} from "./telegram-ru.mjs";
import { buildMessage } from "./notices.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(resolve(HERE, file), "utf8");
const SOURCES = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));

// ------------------------------------------------------------------ разбор исходника (минимальный)
// Не парсер JS: ровно столько, чтобы пройти строки, шаблоны с `${…}`, скобки и тернарник.

const QUOTES = new Set(['"', "'", "`"]);

/** Литерал с позиции `i` (кавычка). Отдаёт `{ end, variants }`; `${…}` → образцы через `inner`. */
function literalAt(src, i, counter) {
  const q = src[i];
  let j = i + 1;
  let variants = [""];
  const add = (s) => { variants = variants.map((v) => v + s); };
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") {
      const c = src[j + 1];
      add(c === "n" ? "\n" : c === "t" ? "\t" : c);
      j += 2;
      continue;
    }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
      const close = closingOf(src, j + 1);
      const alts = inner(src.slice(j + 2, close), counter);
      const next = [];
      for (const v of variants) for (const a of alts) next.push(v + a);
      variants = next;
      j = close + 1;
      continue;
    }
    add(src[j]);
    j++;
  }
  return { end: j + 1, variants };
}

const skipLiteral = (src, i) => literalAt(src, i, { n: 0 }).end;

/** Закрывающая скобка к открывающей на позиции `k` (строки внутри пропускаются). */
function closingOf(src, k) {
  let depth = 0;
  for (let j = k; j < src.length; j++) {
    const c = src[j];
    if (QUOTES.has(c)) { j = skipLiteral(src, j) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return src.length;
}

/** Тернарник верхнего уровня: `{ yes, no }` или null. `?.` и `??` тернарником не считаются. */
function ternary(expr) {
  let depth = 0, q = -1, nested = 0;
  for (let j = 0; j < expr.length; j++) {
    const c = expr[j];
    if (QUOTES.has(c)) { j = skipLiteral(expr, j) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && expr[j + 1] !== "." && expr[j + 1] !== "?" && expr[j - 1] !== "?") {
      if (q === -1) q = j;
      else nested++;
    } else if (depth === 0 && c === ":" && q !== -1) {
      if (nested > 0) nested--;
      else return { yes: expr.slice(q + 1, j), no: expr.slice(j + 1) };
    }
  }
  return null;
}

/** `a ?? "текст"` верхнего уровня — запасной текст, или null. */
function fallback(expr) {
  let depth = 0;
  for (let j = 0; j < expr.length; j++) {
    const c = expr[j];
    if (QUOTES.has(c)) { j = skipLiteral(expr, j) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && expr[j + 1] === "?") return expr.slice(j + 2);
  }
  return null;
}

/** Выражение — один литерал целиком? Тогда его варианты, иначе null. */
function wholeLiteral(expr, counter) {
  const e = expr.trim();
  if (!QUOTES.has(e[0])) return null;
  const lit = literalAt(e, 0, counter);
  return lit.end === e.length ? lit.variants : null;
}

/** Образцы для `${…}` внутри шаблона: ветки тернарника раскрываются, всё прочее — `Xn`. */
function inner(expr, counter) {
  const lit = wholeLiteral(expr, counter);
  if (lit) return lit;
  const t = ternary(expr);
  if (t) return [...inner(t.yes, counter), ...inner(t.no, counter)];
  counter.n++;
  return [`X${counter.n}`];
}

/** Образцы выражения-значения: литерал, литеральные ветки тернарника, запасной текст `??`. */
function samplesOf(expr, counter = { n: 0 }) {
  const lit = wholeLiteral(expr, counter);
  if (lit) return lit;
  const t = ternary(expr);
  if (t) return [...samplesOf(t.yes, counter), ...samplesOf(t.no, counter)];
  const f = fallback(expr);
  if (f !== null) return samplesOf(f, counter);
  return [];
}

/** Аргументы вызова, у которого `(` стоит на позиции `open`. */
function callArgs(src, open) {
  const close = closingOf(src, open);
  const args = [];
  let depth = 0, start = open + 1;
  for (let j = open + 1; j < close; j++) {
    const c = src[j];
    if (QUOTES.has(c)) { j = skipLiteral(src, j) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(src.slice(start, j));
      start = j + 1;
    }
  }
  args.push(src.slice(start, close));
  return args;
}

/** Выражение с позиции `i` до `,`/`;`/закрывающей скобки верхнего уровня. */
function valueAt(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (QUOTES.has(c)) { j = skipLiteral(src, j) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return src.slice(i, j);
      depth--;
    } else if (depth === 0 && (c === "," || c === ";")) return src.slice(i, j);
  }
  return src.slice(i);
}

/** Совпадение стоит в комментарии (строка начинается с `*` или до него на строке есть `//`). */
function inComment(src, index) {
  const lineStart = src.lastIndexOf("\n", index) + 1;
  const before = src.slice(lineStart, index);
  return /^\s*(\*|\/\*)/.test(before) || before.includes("//");
}

/**
 * Английские фразы файла: `re` находит начало, `pick` достаёт из места образцы.
 * Отдаёт `[{ where, sample }]`.
 */
function scan(file, re, pick) {
  const src = read(file);
  const out = [];
  for (const m of src.matchAll(re)) {
    if (inComment(src, m.index)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    for (const sample of pick(src, m)) {
      if (sample.trim() !== "") out.push({ where: `${file}:${line}`, sample });
    }
  }
  return out;
}

const argOf = (n) => (src, m) => {
  const args = callArgs(src, m.index + m[0].length - 1);
  return args.length > n ? samplesOf(args[n]) : [];
};
const valueOf = (src, m) => samplesOf(valueAt(src, m.index + m[0].length));

// Файлы, чьи ошибки становятся ошибкой креатора или обхода — а значит, строкой письма.
// `env.mjs` — сверх списка: его «нет .env.local» уходит письмом «обход не начался».
const ERROR_FILES = [
  "sync.mjs", "tiktok.mjs", "tiktok-gate.mjs", "instagram-web.mjs", "instagram-graph.mjs",
  "instagram-direct.mjs", "direct.mjs", "comments-tiktok.mjs", "comments-instagram.mjs",
  "replies.mjs", "browser.mjs", "images.mjs", "db.mjs", "proxies.mjs", "radmin.mjs", "scope.mjs",
  "schedule.mjs", "requests.mjs", "env.mjs",
];

function collectPhrases() {
  const found = [];
  for (const file of SOURCES) {
    // Литерал второго аргумента замечания — обхода и резидента.
    found.push(...scan(file, /\b(?:residentNotice|notice)\(/g, argOf(1)));
    // Тексты-константы ошибок (`ERR_SESSION`, `ERR_LIMIT`).
    found.push(...scan(file, /\bconst ERR_\w+ = /g, valueOf));
  }
  for (const file of ERROR_FILES) {
    found.push(...scan(file, /\bnew Error\(/g, argOf(0)));
  }
  // Причины прямых путей: доходят до письма через `[direct]` и ошибки якоря.
  for (const file of ["direct.mjs", "instagram-direct.mjs", "instagram-web.mjs", "sync.mjs"]) {
    found.push(...scan(file, /\bwhy: /g, valueOf));
  }
  found.push(...scan("instagram-web.mjs", /\bno\(/g, argOf(0)));
  // Беды картинок и открытия страницы видео.
  for (const file of ["images.mjs", "comments-tiktok.mjs", "instagram-direct.mjs"]) {
    found.push(...scan(file, /\berror: /g, valueOf));
  }
  found.push(...scan("comments-tiktok.mjs", /\bconst why = /g, valueOf));
  // Тексты, собранные в переменную до `notice(…, text)`.
  for (const file of ["radmin.mjs", "tiktok.mjs", "notices.mjs"]) {
    found.push(...scan(file, /\bconst text = /g, valueOf));
  }
  found.push(...scan("tiktok.mjs", /\bconst where = /g, valueOf));
  found.push(...scan("scope.mjs", /\btext: /g, valueOf));
  // Беды профиля браузера (`forceOffscreenPlacement`, `forgetSession`) уходят в `[browser]`.
  found.push(...scan("browser.mjs", /\breturn /g, valueOf));
  return found;
}

// 🔴 Фразы, которые переводить не нужно. Ключ — образец слово в слово, значение — причина.
const EXCEPTIONS = new Map([
  // Переходники: сами слов не несут, текст внутри переводится своей парой.
  ["@X1: X2", "`@handle: <text>` — the text inside has its own pair"],
  ["X1: @X2", "tiktok.mjs `${text}: @handle` — the text is «TikTok returned no list…», covered below"],
  ["Instagram: X1", "instagram-web.mjs wraps a launchProfile error — the error has its own pair"],
  // Ответ базы: метод, путь, код и тело PostgREST — переводить нечего.
  ["X1 X2 → HTTP X3: X4", "db.mjs: PostgREST method, path and body as is"],
  ["HEAD X1 → HTTP X2", "db.mjs: PostgREST path and status as is"],
  // Коды и тексты чужих ответов — как их отдала площадка.
  ["HTTP X1", "HTTP status, readable as is"],
  ["status_code X1: X2", "TikTok's own status_code and status_msg"],
  ["status_code X1", "TikTok's own status_code"],
  ["GraphQL: X1", "Instagram's own GraphQL error text"],
  // Ярлык домашнего адреса (`addressLabel`): переводится словарём места `{address}`, а
  // однословная пара в таблице запрещена — рекурсия задела бы ручку `@home`.
  ["home", "browser.mjs addressLabel — translated only inside {address} (addressRu)"],
]);

// Слова, которые в русском письме остаются латиницей: имена площадок и программ, поля ответов,
// переменные настроек, пути. Любое другое английское слово в переводе — недопереведённая фраза.
const LATIN_OK = new Set([
  "Amestat", "TikTok", "Instagram", "Opera", "opera", "Radmin", "Realtime", "Reels", "Graph", "API", "GraphQL",
  "HTTP", "JSON", "HTML", "Supabase", "Telegram",
  "handle", "cookie", "sessionid", "login_required", "userInfo", "comments", "child_comments", "user",
  "__UNIVERSAL_DATA_FOR_REHYDRATION__", "sync_runs", "video", "photo",
  "Default", "Preferences", "Sessions", "LOCALAPPDATA", "Programs",
  "AMESTAT_BROWSER", "IG_ACCESS_TOKEN", "IG_USER_ID", "IG_SOURCE", "web", "env", "local", "example",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
]);

const CYRILLIC = /[А-Яа-яЁё]/;
const leftovers = (text) => (String(text).replace(/\bX\d+\b/g, "").match(/[A-Za-z_]{3,}/g) ?? []).filter((w) => !LATIN_OK.has(w));

test("coverage: every English phrase that can reach Telegram has a Russian pair", () => {
  const found = collectPhrases();
  // Сканер вообще что-то видит: иначе тест проходил бы молча на пустоте.
  assert.ok(found.length > 150, `the scanner found only ${found.length} phrases`);
  const missing = [];
  for (const { where, sample } of found) {
    if (EXCEPTIONS.has(sample)) continue;
    const ru = toRussian(sample);
    const left = leftovers(ru);
    if (!CYRILLIC.test(ru) || left.length > 0) missing.push(`${where}: ${sample}  →  ${ru}${left.length ? `  [English: ${left.join(", ")}]` : ""}`);
  }
  assert.deepEqual(missing, [], `phrases without a Russian pair:\n${missing.join("\n")}`);
});

test("coverage: every exception is still found in the sources", () => {
  const samples = new Set(collectPhrases().map((f) => f.sample));
  const stale = [...EXCEPTIONS.keys()].filter((s) => !samples.has(s));
  assert.deepEqual(stale, [], "an exception no longer matches anything — remove it");
});

// Тексты, которые собираются из кусков в разных местах, — живыми примерами, как их увидит владелец.
const LIVE = [
  ["@orandocom.lis: empty list: not a single video came back (in DB 7)",
    "@orandocom.lis: список пуст: не пришло ни одного видео (в базе 7)"],
  ["@aurea.ora: empty list: not a single video came back (in DB 7, profile says 9)",
    "@aurea.ora: список пуст: не пришло ни одного видео (в базе 7, по профилю 9)"],
  ["@aurea.ora: list ended at 5 videos, but the profile says 9",
    "@aurea.ora: список кончился на 5 видео, а по профилю 9"],
  ["@orandocom.lis: not found in the profile, looks deleted — 12 videos from 01.09, 02.09, 03.09, 04.09, 05.09, 06.09, 07.09, 08.09, 09.09, 10.09 and 2 more; links are in the run log, I will not report these videos again",
    "@orandocom.lis: нет в профиле, похоже, удалены — 12 видео от 01.09, 02.09, 03.09, 04.09, 05.09, 06.09, 07.09, 08.09, 09.09, 10.09 и ещё 2; ссылки в логе обхода, об этих видео больше не пишу"],
  ["the run was interrupted: @aurea.ora: Instagram: the browser did not start (Opera C:\\Opera\\opera.exe, address: home): browserType.launchPersistentContext: Timeout 60000ms exceeded.",
    "обход прерван: @aurea.ora: Instagram: браузер не запустился (Opera C:\\Opera\\opera.exe, адрес: домашний): browserType.launchPersistentContext: Timeout 60000ms exceeded."],
  ["the run did not start: no file C:\\Amestat\\.env.local — copy .env.local.example to .env.local and fill it in",
    "обход не начался: нет файла C:\\Amestat\\.env.local — скопируй .env.local.example в .env.local и заполни"],
  ["@natalia.ora1: TikTok returned no list (address throttling: home, proxy #1 5.6.7.8; profile says 41 videos)",
    "@natalia.ora1: TikTok не отдал список (защита по адресу: домашний, прокси #1 5.6.7.8; по профилю 41 видео)"],
  ["@natalia.ora1: TikTok returned no list (address throttling; profile says 41 videos): @natalia.ora1",
    "@natalia.ora1: TikTok не отдал список (защита по адресу; по профилю 41 видео): @natalia.ora1"],
  ["natalia.ora1 video 7412: not enough time for branches, opened 3 of 9",
    "natalia.ora1 видео 7412: на ветки не хватило времени, раскрыто 3 из 9"],
  ["natgeo post 3712: no replies collected from any of the 4 branches",
    "natgeo публикация 3712: ответы не снялись ни у одной из 4 веток"],
  ["profile-tiktok: khaby.lame video 55 — 6 empty comment responses (has the fake account session in this profile copy expired? is the window hidden?)",
    "profile-tiktok: khaby.lame видео 55 — 6 пустых ответов на комментарии (сессия фейка в этой копии профиля истекла? окно скрыто?)"],
  ["@mrbeast video 7412: TikTok did not request comments for video 7412: tab did not open, on screen «Log in»",
    "@mrbeast видео 7412: TikTok не запросил комментарии видео 7412: вкладка не открылась, на экране «Log in»"],
  ["@entusiasta.f1: the direct request gave nothing on 2 of 5 videos — anchor: anchor landed on /accounts/login/ — the browser will check the session",
    "@entusiasta.f1: прямой запрос не дал на 2 видео из 5 — якорь: якорь попал на /accounts/login/ — сессию проверит браузер"],
  ["@natgeo: the Instagram list via direct request gave nothing — feed: request failed: no response (page 3)",
    "@natgeo: прямой запрос списка Instagram не дал ничего — лента: запрос не прошёл: нет ответа (страница 3)"],
  ["covers/7412.jpg: download failed — not an image (type not stated)",
    "covers/7412.jpg: не скачалась — не картинка (тип не назван)"],
  ["Radmin not turned off: task \"Radmin off\" did not start (access denied)",
    "Radmin не выключен: задача «Radmin off» не запустилась (access denied)"],
  ["instagram (profile-opera): the login cookie expires in 9 d — log in to Opera again and take a fresh profile copy",
    "instagram (profile-opera): cookie входа истекает через 9 дн. — войди в Opera заново и сними копию профиля"],
  ["3 more creators with the same old errors (see earlier messages)",
    "ещё 3 креаторов с прежними ошибками (см. прошлые письма)"],
  ["1 more old notices, all the same (see earlier messages)",
    "ещё 1 прежних замечаний, всё те же (см. прошлые письма)"],
  ["polling for requests failing 3 times in a row: fetch failed",
    "опрос просьб не выходит 3 раз подряд: fetch failed"],
  ["the run for slot 14:02 (manual request) failed — a retry is scheduled for 14:32:00",
    "обход слота 14:02 (ручная просьба) не удался — повтор назначен на 14:32:00"],
  ["@demo.olya: Instagram: profile not found: @demo.olya",
    "@demo.olya: Instagram: профиль не найден: @demo.olya"],
];

test("toRussian: live texts come out as the owner will read them", () => {
  for (const [en, ru] of LIVE) assert.equal(toRussian(en), ru);
});

test("toRussian: unknown text passes unchanged — handles, numbers, system errors", () => {
  for (const s of ["fetch failed", "page.goto: Timeout 30000ms exceeded.", "@aurea.ora: fetch failed", "12345", "", "home", "@home: fetch failed"]) {
    assert.equal(toRussian(s), s);
  }
  assert.equal(toRussian(null), "");
});

test("toRussian: nesting stops at depth 4 — deeper text stays as is", () => {
  const wrap = (s, n) => (n === 0 ? s : wrap(`the run was interrupted: ${s}`, n - 1));
  const deep = toRussian(wrap("the retry crashed: fetch failed", 5));
  // Уровни 0…4 переведены, шестой по счёту текст оставлен английским.
  assert.equal(deep, `${"обход прерван: ".repeat(5)}the retry crashed: fetch failed`);
});

test("table: every pair translates its own sample — no pair is shadowed by an earlier one", () => {
  for (const [en, ru] of PAIRS) {
    let n = 0;
    const values = {};
    const sample = en.replace(/\{(\w+)\}/g, (_, name) => {
      values[name] = `X${++n}`;
      return values[name];
    });
    const want = ru.replace(/\{(\w+)\}/g, (_, name) => values[name]);
    assert.equal(toRussian(sample), want, `pair "${en}"`);
  }
});

test("table: no overly general patterns and no English left in Russian templates", () => {
  // `@{handle}: {error}` — единственный шаблон без слов: переходник ошибки креатора (sync.mjs).
  const GENERAL_OK = new Set(["@{handle}: {error}"]);
  const seen = new Set();
  for (const [en, ru] of PAIRS) {
    assert.ok(!seen.has(en), `duplicate pair "${en}"`);
    seen.add(en);
    const literal = en.replace(/\{\w+\}/g, "");
    if (!GENERAL_OK.has(en)) assert.match(literal, /[A-Za-z]{2,}/, `pattern without words: "${en}"`);
    if (!/\{\w+\}/.test(en)) assert.match(en, / /, `one-word pattern: "${en}"`);
    assert.deepEqual(leftovers(ru.replace(/\{\w+\}/g, "")), [], `English left in "${ru}"`);
  }
});

test("depthLabelRu: words as before the translation, range with its edges", () => {
  assert.equal(depthLabelRu("all"), "всё");
  assert.equal(depthLabelRu("week"), "неделя");
  assert.equal(depthLabelRu("month"), "месяц");
  assert.equal(depthLabelRu("range"), "период");
  assert.equal(depthLabelRu("nonsense"), "всё");
  const from = new Date(2026, 8, 1).getTime();
  const to = new Date(2026, 8, 9, 23, 59).getTime();
  assert.equal(depthLabelRu("range", from, to), "период 01.09–09.09");
});

test("runHeadRu / residentHeadRu: headers of the Russian messages", () => {
  assert.equal(
    runHeadRu({ runId: 140, trigger: "schedule", depth: "week", done: 7, failed: 1 }),
    "Amestat, обход #140 (schedule, неделя): собрано 7, с ошибкой 1",
  );
  assert.equal(
    runHeadRu({ runId: null, trigger: "retry", depth: "all", done: 0, failed: 2, slotLabel: "14:02 (manual request)" }),
    "Amestat, обход #? (retry, всё): собрано 0, с ошибкой 2\nвторая неудача подряд после слота 14:02 (ручная просьба)",
  );
  assert.equal(residentHeadRu(3), "Amestat, резидент: замечаний 3");
});

test("buildMessage: Russian tail by parameter, the English default stays", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ code: "creator", text: `@creator${i}: fetch failed` }));
  assert.match(buildMessage("header", many, 300, moreRu).split("\n").at(-1), /^… и ещё \d+$/);
  assert.match(buildMessage("header", many, 300).split("\n").at(-1), /^… and \d+ more$/);
});

test("itemsRu: the code stays Latin, the text becomes Russian, the counter is kept", () => {
  const items = [{ code: "missing", text: "@orandocom.lis: empty list: not a single video came back (in DB 7)", count: 2 }];
  assert.deepEqual(itemsRu(items), [{ code: "missing", text: "@orandocom.lis: список пуст: не пришло ни одного видео (в базе 7)", count: 2 }]);
  assert.equal(
    buildMessage(runHeadRu({ runId: 141, trigger: "schedule", depth: "all", done: 8, failed: 0 }), itemsRu(items), 3500, moreRu),
    "Amestat, обход #141 (schedule, всё): собрано 8, с ошибкой 0\n[missing] @orandocom.lis: список пуст: не пришло ни одного видео (в базе 7) (×2)",
  );
});

test("retryFailedRu and the test message: wording as before the translation", () => {
  assert.equal(
    retryFailedRu({ slotLabel: "14:00", retryLabel: "15:00", error: "fetch failed" }),
    "Amestat: повтор обхода не смог начаться. Слот 14:00, повтор 15:00.\nБаза не ответила: fetch failed\nСтроки в sync_runs нет — на сайте этого тоже не видно.",
  );
  assert.match(TEST_MESSAGE_RU, /^Amestat: пробное сообщение от сборщика\./);
});

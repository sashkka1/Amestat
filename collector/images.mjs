// Картинки Instagram к себе в хранилище: аватар креатора и обложки его видео.
//
// Зачем вообще: Instagram отдаёт картинки подписанными адресами на `instagram.f*.fbcdn.net`
// и `scontent-*.cdninstagram.com`, а вместе с картинкой — заголовок
// `Cross-Origin-Resource-Policy: same-origin`. Браузер на нашем сайте такую картинку не
// рисует вовсе (`net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`), хотя из Node она качается
// обычным `fetch` без всяких хитростей. Поэтому качаем сами и кладём в свой бакет,
// а в базу пишем наш публичный адрес.
//
// Куда: бакет `avatars` Supabase Storage — тот самый, куда владелец загружает свои картинки
// (миграция `../supabase/migrations/20260907142636_init.sql`, раздел про storage). Читать
// его может кто угодно (бакет публичный), писать — только `service_role`, то есть сборщик.
//
// ⚠️ TikTok свои обложки отдаёт без этого заголовка и показывается как есть — его картинки
// через этот модуль не идут.
//
// 🔴 Ничто здесь обход не валит: не скачалось или не залилось — `null` и строка в лог.

import { loadEnv } from "./env.mjs";
import { notice } from "./notices.mjs";

const BUCKET = "avatars";
const TIMEOUT_MS = 15_000;
// Потолок тот же, что у бакета в миграции (`file_size_limit` = 5 МБ): больше не примут.
const MAX_BYTES = 5 * 1024 * 1024;
// Картинка отдаётся и без cookies, но с браузерным `user-agent` меньше поводов для отказа.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const prefixOf = (supabaseUrl) => `${supabaseUrl}/storage/v1/object/public/${BUCKET}/`;

/** Путь аватара креатора в бакете. */
export const avatarPath = (creatorId) => `instagram/${creatorId}/avatar.jpg`;

/** Путь обложки видео в бакете. */
export const coverPath = (creatorId, videoId) => `instagram/${creatorId}/${videoId}.jpg`;

/** Публичный адрес того, что лежит в бакете по `path`. Второй аргумент — только для тестов. */
export const publicUrl = (path, supabaseUrl = null) => prefixOf(supabaseUrl ?? loadEnv().supabaseUrl) + path;

/**
 * Наш ли это адрес — то есть картинка уже переложена и качать её снова незачем.
 * Второй аргумент — только для тестов: обычно адрес проекта берётся из `../.env.local`.
 */
export function isOurs(url, supabaseUrl = null) {
  if (!url) return false;
  return String(url).startsWith(prefixOf(supabaseUrl ?? loadEnv().supabaseUrl));
}

/**
 * Скачивание с таймаутом и потолком. Отдаёт `{ bytes, type }` либо `{ error }` — не бросает.
 * Не-2xx, не-картинка и слишком большое тело — обычный отказ, а не беда.
 */
async function download(sourceUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, {
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "image/*,*/*;q=0.8" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return { error: `не картинка (${type || "тип не назван"})` };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return { error: `${Math.round(declared / 1024)} КБ — больше потолка` };
    if (!res.body) return { error: "пустой ответ" };
    // Считаем по ходу, а не по заголовку: `content-length` бывает и не назван.
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_BYTES) return { error: `больше ${MAX_BYTES / 1024 / 1024} МБ — не берём` };
      chunks.push(chunk);
    }
    if (size === 0) return { error: "пустой ответ" };
    return { bytes: Buffer.concat(chunks), type };
  } catch (e) {
    return { error: ctrl.signal.aborted ? `не ответил за ${TIMEOUT_MS / 1000} с` : String(e?.message ?? e).split("\n")[0] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Заливка в бакет поверх прежнего (`x-upsert`). Отдаёт `null`, если легло, иначе текст беды.
 * ⚠️ Бакет принимает только `image/jpeg`, `image/png` и `image/webp` (список в миграции):
 * что-то иное вернётся отказом 400 и уйдёт строкой в лог.
 */
async function upload(path, bytes, type, { supabaseUrl, serviceKey }) {
  const res = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      // Storage смотрит именно в Authorization — одного `apikey` ему, в отличие от PostgREST, мало.
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": type,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (res.ok) return null;
  // ⚠️ Ключей в тексте нет: Storage возвращает только своё сообщение.
  const text = await res.text().catch(() => "");
  return `HTTP ${res.status}: ${text.slice(0, 200)}`;
}

/**
 * Переложить одну картинку: скачать по `sourceUrl` и залить в бакет по `path`.
 * Отдаёт публичный адрес или `null`. Исключений не бросает: беда — строка в лог и `null`,
 * обход из-за картинки неудачным не считается.
 */
export async function rehostImage(sourceUrl, path, { log } = {}) {
  if (!sourceUrl) return null;
  let env;
  try {
    env = loadEnv();
  } catch (e) {
    log?.(`  картинка ${path}: ${String(e?.message ?? e).split("\n")[0]}`);
    return null;
  }
  const got = await download(sourceUrl);
  if (got.error) {
    // В лог идёт путь в бакете, а не исходный адрес: подписанный адрес Instagram длиной в экран.
    log?.(`  картинка ${path}: не скачалась — ${got.error}`);
    notice("images", `${path}: не скачалась — ${got.error}`);
    return null;
  }
  const bad = await upload(path, got.bytes, got.type, env).catch((e) => String(e?.message ?? e).split("\n")[0]);
  if (bad) {
    log?.(`  картинка ${path}: не залилась — ${bad}`);
    notice("images", `${path}: не залилась — ${bad}`);
    return null;
  }
  return publicUrl(path, env.supabaseUrl);
}

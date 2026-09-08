// Ходы в Supabase по REST (PostgREST). Сборщик ходит ключом service_role и RLS не подчиняется.
//
// Батчи по 100 строк: у креатора бывает несколько сотен видео, а один огромный POST
// и упирается в размер тела, и теряет всё целиком при обрыве.

import { loadEnv } from "./env.mjs";

const BATCH = 100;

function headers(prefer) {
  const { serviceKey } = loadEnv();
  const h = {
    apikey: serviceKey,
    "Content-Type": "application/json",
    // `Bearer` — для ключа-JWT (`eyJ…`); новые `sb_secret_…` идут одним заголовком apikey.
    ...(serviceKey.startsWith("eyJ") ? { Authorization: `Bearer ${serviceKey}` } : {}),
    ...(prefer ? { Prefer: prefer } : {}),
  };
  return h;
}

async function call(method, path, body, prefer) {
  const { supabaseUrl } = loadEnv();
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: headers(prefer),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // В текст ошибки ключи не попадают: PostgREST возвращает только сообщение базы.
    throw new Error(`${method} ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** GET: `get("creators?select=*&order=sort_order")` → массив строк. */
export async function get(path) {
  return (await call("GET", path, undefined, undefined)) ?? [];
}

/** POST одной строки с возвратом её самой (нужен id) → объект. */
export async function insertReturning(table, row) {
  const rows = await call("POST", table, row, "return=representation");
  return Array.isArray(rows) ? rows[0] : rows;
}

/** POST многих строк без возврата. Батчами по 100. */
export async function insertMany(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await call("POST", table, rows.slice(i, i + BATCH), "return=minimal");
  }
  return rows.length;
}

/** UPSERT по конфликту (`on_conflict=id`): что есть — обновить, чего нет — вставить. */
export async function upsert(table, rows, onConflict = "id") {
  for (let i = 0; i < rows.length; i += BATCH) {
    await call("POST", `${table}?on_conflict=${onConflict}`, rows.slice(i, i + BATCH), "resolution=merge-duplicates,return=minimal");
  }
  return rows.length;
}

/** PATCH: `patch("creators?id=eq.<uuid>", { sync_error: null })`. */
export async function patch(path, body) {
  await call("PATCH", path, body, "return=minimal");
}

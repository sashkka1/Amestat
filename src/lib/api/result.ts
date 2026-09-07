// Единый ответ всех операций с базой: либо данные, либо русский текст ошибки для тоста.
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

export const UNIQUE_VIOLATION = "23505";

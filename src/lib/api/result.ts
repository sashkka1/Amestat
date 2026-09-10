// Единый ответ всех операций с базой: либо данные, либо русский текст ошибки для тоста.
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

export const UNIQUE_VIOLATION = "23505";

// Коды, которыми база бросает СВОИ сообщения (`raise exception` в миграциях): текст там
// уже написан для человека, и заворачивать его во второе «Не удалось…» незачем.
const RAISED = new Set(["P0001", "42501"]);

export function isRaised(error: { code?: string } | null): boolean {
  return error?.code !== undefined && RAISED.has(error.code);
}

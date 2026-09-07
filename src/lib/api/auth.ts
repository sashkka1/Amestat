import { createClient } from "@/lib/supabase/client";
import { fail, type ActionResult } from "./result";

export async function login(email: string, password: string): Promise<ActionResult> {
  const e = email.trim();
  if (!e || !password) return fail("Введите почту и пароль");

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: e, password });
  if (error) {
    return fail(
      error.code === "invalid_credentials" || error.status === 400
        ? "Неверная почта или пароль"
        : `Не удалось войти: ${error.message}`,
    );
  }
  return { ok: true, data: undefined };
}

export async function logout(): Promise<void> {
  await createClient().auth.signOut();
}

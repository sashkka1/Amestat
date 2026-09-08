import { createClient } from "@/lib/supabase/client";
import { loginToEmail } from "@/lib/login-email";
import type { InviteCheck } from "@/lib/types";
import { fail, type ActionResult } from "./result";

// Вход по логину или почте: в поле пускаем и то, и то, адрес для Auth считаем сами.
export async function login(loginOrEmail: string, password: string): Promise<ActionResult> {
  const raw = loginOrEmail.trim();
  if (!raw || !password) return fail("Введите логин и пароль");

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: loginToEmail(raw),
    password,
  });
  if (error) {
    return fail(
      error.code === "invalid_credentials" || error.status === 400
        ? "Неверный логин или пароль"
        : `Не удалось войти: ${error.message}`,
    );
  }
  return { ok: true, data: undefined };
}

// Отказы триггера регистрации Supabase наружу не отдаёт — вместо текста исключения
// приходит общее «Database error saving new user». Поэтому причину сайт узнаёт заранее,
// двумя функциями базы (миграция v5), а триггер остаётся замком на случай обхода сайта.
export const INVITE_REASON: Record<Exclude<InviteCheck, "ok">, string> = {
  invalid: "Ссылка недействительна",
  used: "Ссылка уже использована",
  expired: "Срок ссылки истёк",
};

export async function checkInvite(token: string): Promise<ActionResult<InviteCheck>> {
  const { data, error } = await createClient().rpc("check_invite", { p_token: token });
  if (error) return fail(`Не удалось проверить ссылку: ${error.message}`);
  return { ok: true, data: data ?? "invalid" };
}

export async function isLoginTaken(login: string): Promise<ActionResult<boolean>> {
  const { data, error } = await createClient().rpc("login_taken", { p_login: login.trim() });
  if (error) return fail(`Не удалось проверить логин: ${error.message}`);
  return { ok: true, data: data === true };
}

// Регистрация по одноразовой ссылке. Причины отказа выясняются до `signUp`, чтобы
// показать их по-русски; сам `signUp` остаётся последней проверкой.
export async function registerByInvite(input: {
  token: string;
  login: string;
  password: string;
  displayName: string;
}): Promise<ActionResult> {
  const loginText = input.login.trim();
  if (!loginText) return fail("Введите логин");
  if (input.password.length < 8) return fail("Пароль короче 8 символов");

  const supabase = createClient();

  const taken = await isLoginTaken(loginText);
  if (!taken.ok) return taken;
  if (taken.data) return fail("Такой логин уже занят");

  const email = loginToEmail(loginText);
  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: {
      data: {
        invite: input.token,
        login: loginText,
        display_name: input.displayName.trim(),
        via_signup: "true",
      },
    },
  });
  if (error) return fail(`Не удалось зарегистрироваться: ${error.message}`);

  // Подтверждение почты триггер проставляет сам, но сессию signUp отдаёт не всегда.
  if (!data.session) {
    const signedIn = await supabase.auth.signInWithPassword({ email, password: input.password });
    if (signedIn.error) return fail(`Регистрация прошла, но войти не вышло: ${signedIn.error.message}`);
  }
  return { ok: true, data: undefined };
}

export async function logout(): Promise<void> {
  await createClient().auth.signOut();
}

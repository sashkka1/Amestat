import { createClient } from "@/lib/supabase/client";
import { loginToEmail } from "@/lib/login-email";
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

// Регистрация по одноразовой ссылке. Проверяет токен триггер базы `handle_new_user`:
// его русские отказы («Ссылка уже использована», «Такой логин уже занят») показываем как есть.
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
  if (error) return fail(error.message);

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

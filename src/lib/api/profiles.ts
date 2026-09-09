import { createClient } from "@/lib/supabase/client";
import { tr } from "@/lib/i18n";
import type { Profile } from "@/lib/types";
import { fail, type ActionResult } from "./result";

// Профиль вошедшего: null — строки нет, доступ не выдан.
export async function myProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await createClient()
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Все менеджеры. Видит только админ — RLS менеджеру отдаст лишь его собственную строку.
export async function listManagers(): Promise<Profile[]> {
  const { data, error } = await createClient()
    .from("profiles")
    .select("*")
    .eq("role", "manager")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listProfiles(): Promise<Profile[]> {
  const { data, error } = await createClient().from("profiles").select("*");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function profileById(userId: string): Promise<Profile | null> {
  const { data, error } = await createClient()
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateDisplayName(userId: string, displayName: string): Promise<ActionResult> {
  const { error } = await createClient()
    .from("profiles")
    .update({ display_name: displayName.trim() })
    .eq("user_id", userId);
  if (error) return fail(tr("api.profileNameFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

// Пароль менеджеру ставит база: старого админ не видит, новый уходит в auth.users.
export async function setManagerPassword(userId: string, password: string): Promise<ActionResult> {
  if (password.length < 8) return fail(tr("api.authPasswordShort"));
  const { error } = await createClient().rpc("admin_set_password", {
    p_user: userId,
    p_password: password,
  });
  if (error) return fail(tr("api.profilePasswordFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

// Удаление менеджера: уходит строка profiles и связи с креаторами. Пользователь Auth
// остаётся, но без профиля на сайт не попадёт — увидит «Доступ не выдан».
export async function deleteManager(userId: string): Promise<ActionResult> {
  const { error } = await createClient().from("profiles").delete().eq("user_id", userId);
  if (error) return fail(tr("api.profileDeleteFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

// Имя для показа: что задал менеджер, иначе логин.
export function profileName(p: Pick<Profile, "display_name" | "login">): string {
  return p.display_name.trim() || p.login;
}

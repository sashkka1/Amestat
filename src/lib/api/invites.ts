import { createClient } from "@/lib/supabase/client";
import { siteUrl } from "@/lib/base-path";
import type { Invite } from "@/lib/types";
import { fail, type ActionResult } from "./result";

// Ссылку выпускает сам админ обычной вставкой: токен и срок ставит база (миграция v3).
export async function createInvite(
  note: string,
  adminUserId: string,
): Promise<ActionResult<{ url: string; token: string; expires_at: string }>> {
  const { data, error } = await createClient()
    .from("invites")
    .insert({ note: note.trim(), created_by: adminUserId })
    .select("token, expires_at")
    .single();
  if (error) return fail(`Не удалось выпустить ссылку: ${error.message}`);
  return {
    ok: true,
    data: {
      token: data.token,
      expires_at: data.expires_at,
      url: siteUrl(`/register/?t=${encodeURIComponent(data.token)}`),
    },
  };
}

export function inviteUrl(token: string): string {
  return siteUrl(`/register/?t=${encodeURIComponent(token)}`);
}

// Журнал ссылок регистрации. Видит и чистит только админ (RLS).
export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await createClient()
    .from("invites")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function deleteInvite(id: string): Promise<ActionResult> {
  const { error } = await createClient().from("invites").delete().eq("id", id);
  if (error) return fail(`Не удалось удалить ссылку: ${error.message}`);
  return { ok: true, data: undefined };
}

export type InviteState =
  | { kind: "used"; login: string; at: string }
  | { kind: "expired" }
  | { kind: "open" };

// Состояние ссылки: погашена (кем и когда), просрочена или ещё ждёт.
export function inviteState(invite: Invite, loginById: Map<string, string>): InviteState {
  if (invite.used_at) {
    const login = (invite.used_by && loginById.get(invite.used_by)) || "неизвестно кем";
    return { kind: "used", login, at: invite.used_at };
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) return { kind: "expired" };
  return { kind: "open" };
}

// «отправлена N дней назад» — целые сутки от создания.
export function daysAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

export function daysAgoText(iso: string): string {
  const d = daysAgo(iso);
  if (d === 0) return "отправлена сегодня";
  return `отправлена ${d} ${plural(d, "день", "дня", "дней")} назад`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

"use client";

import { createContext, useContext } from "react";
import type { Profile } from "@/lib/types";

// Профиль вошедшего (роль, логин, имя). Кладёт AuthGate; ниже него профиль всегда есть.
const ProfileContext = createContext<Profile | null>(null);

export const ProfileProvider = ProfileContext.Provider;

export function useProfile(): Profile {
  const p = useContext(ProfileContext);
  if (!p) throw new Error("useProfile called outside AuthGate");
  return p;
}

export function useIsAdmin(): boolean {
  return useProfile().role === "admin";
}

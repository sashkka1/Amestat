"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api/auth";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const router = useRouter();
  const t = useT();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await login(account, password);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.replace("/");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account">{t("login.account")}</Label>
        <Input
          id="account"
          name="account"
          type="text"
          autoComplete="username"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          autoFocus
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("login.password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} size="lg">
        {pending ? t("login.submitting") : t("login.submit")}
      </Button>
    </form>
  );
}

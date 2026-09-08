"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { INVITE_REASON, checkInvite, registerByInvite } from "@/lib/api/auth";
import { useLoader } from "@/lib/use-loader";

// Страница публичная: сюда приходят по одноразовой ссылке от админа. Токен проверяет
// триггер базы, его русские отказы показываем как есть.
export default function RegisterPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Suspense fallback={<Shell>Готовим форму…</Shell>}>
        <RegisterRoute />
      </Suspense>
    </main>
  );
}

function RegisterRoute() {
  const params = useSearchParams();
  const token = params.get("t") ?? "";
  if (!token) {
    return (
      <Shell>
        В адресе нет ссылки-приглашения. Попросите администратора прислать её заново.
      </Shell>
    );
  }
  return <RegisterGate token={token} />;
}

// Ссылку проверяем до формы: заполнять её ради отказа в конце незачем.
function RegisterGate({ token }: { token: string }) {
  const { data, error, loading } = useLoader(() => checkInvite(token), [token]);

  if (loading || !data) {
    return (
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm" aria-busy="true">
        <Skeleton className="mb-3 h-7 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error) return <Shell>Не удалось проверить ссылку: {error}</Shell>;
  if (!data.ok) return <Shell>{data.error}</Shell>;
  if (data.data !== "ok") {
    return (
      <Shell>
        {INVITE_REASON[data.data]}. Попросите администратора прислать новую ссылку.
      </Shell>
    );
  }
  return <RegisterForm token={token} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-sm rounded-xl border bg-card p-6 text-center shadow-sm">
      <h1 className="mb-2 text-xl font-semibold tracking-tight">Регистрация</h1>
      <p className="mb-5 text-sm text-muted-foreground">{children}</p>
      <Link
        href="/login/"
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Ко входу
      </Link>
    </div>
  );
}

function RegisterForm({ token }: { token: string }) {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError("Пароли не совпадают");
      return;
    }
    setPending(true);
    try {
      const res = await registerByInvite({ token, login, password, displayName });
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
    <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Amestat</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Регистрация креатор-менеджера по приглашению.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login">Логин</Label>
          <Input
            id="login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
          <p className="text-xs text-muted-foreground">По нему вы будете входить. Можно и почту.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Пароль</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password2">Пароль ещё раз</Label>
          <Input
            id="password2"
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="display-name">Имя</Label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="необязательно"
            autoComplete="name"
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} size="lg">
          {pending ? "Регистрируем…" : "Зарегистрироваться"}
        </Button>
      </form>
    </div>
  );
}

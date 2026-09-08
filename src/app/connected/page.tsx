import Link from "next/link";

// Публичная страница возврата: сюда креатора приведёт подключение через площадку,
// когда оно появится. Ничего не читает и не пишет — просто говорит, что всё прошло.
export const metadata = { title: "Готово — Amestat" };

export default function ConnectedPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Готово</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Аккаунт подключён. Эту вкладку можно закрыть — статистика появится после ближайшего обхода.
        </p>
        <Link
          href="/"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          На главную
        </Link>
      </div>
    </main>
  );
}

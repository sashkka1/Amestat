import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Такой страницы нет</h1>
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        К списку креаторов
      </Link>
    </main>
  );
}

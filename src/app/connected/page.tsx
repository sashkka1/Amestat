import { ru } from "@/lib/i18n/ru";
import { ConnectedView } from "./connected-view";

// Публичная страница возврата: сюда креатора приведёт подключение через площадку,
// когда оно появится. Ничего не читает и не пишет — просто говорит, что всё прошло.
// ⚠️ `metadata` статика печатает при сборке, языка тогда ещё нет — берём русский, основной.
export const metadata = { title: ru.meta.connected };

export default function ConnectedPage() {
  return <ConnectedView />;
}

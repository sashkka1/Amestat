import { createClient } from "@/lib/supabase/client";
import { tr } from "@/lib/i18n";
import type { CoveredVideo } from "@/lib/payment";
import type { PaymentRulesUpdate } from "@/lib/types";
import { fail, isRaised, type ActionResult } from "./result";

// Оплата креаторам (миграция v37). Всё здесь — только для администратора: правила базы
// спрашивают `is_admin()` сами, кнопки на экране лишь не показываются лишним.

export async function savePaymentRules(
  creatorId: string,
  values: PaymentRulesUpdate,
): Promise<ActionResult> {
  const { error } = await createClient()
    .from("payment_rules")
    .update(values)
    .eq("creator_id", creatorId);
  if (error) return fail(tr("api.rulesSaveFailed", { message: error.message }));
  return { ok: true, data: undefined };
}

// Документ выплаты. Тип файла любой — чек бывает и pdf, и снимком экрана; потолок тот же,
// что у бакета (20 МБ), иначе отказ придёт уже от хранилища и без внятного текста.
export const RECEIPT_MAX_BYTES = 20 * 1024 * 1024;

export async function uploadReceipt(
  creatorId: string,
  file: File,
): Promise<ActionResult<{ path: string; name: string }>> {
  if (file.size > RECEIPT_MAX_BYTES) return fail(tr("api.receiptTooBig"));
  // Имя в бакете своё: в исходном бывают пробелы и кириллица, а ключ объекта должен быть
  // предсказуемым. Настоящее имя уходит в запись платежа и показывается в истории.
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const path = `${creatorId}/${Date.now()}${ext ? `.${ext}` : ""}`;
  const { error } = await createClient()
    .storage.from("receipts")
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (error) return fail(tr("api.receiptUploadFailed", { message: error.message }));
  return { ok: true, data: { path, name: file.name } };
}

// Бакет приватный, поэтому прямого адреса у документа нет: на каждое скачивание берётся
// подписанная ссылка на час.
export async function receiptUrl(path: string): Promise<ActionResult<string>> {
  const { data, error } = await createClient().storage.from("receipts").createSignedUrl(path, 3600);
  if (error || !data) return fail(tr("api.receiptLinkFailed", { message: error?.message ?? "" }));
  return { ok: true, data: data.signedUrl };
}

// Запись выплаты: строка платежа и замороженные суммы закрытых видео — одной транзакцией
// в базе (`record_payment`). Суммы считает сайт (`lib/payment.ts`) и передаёт как есть:
// формула одна, и второй раз её в базе не пишут.
export async function recordPayment(input: {
  creatorId: string;
  amount: number;
  docPath: string;
  docName: string;
  note: string;
  videos: CoveredVideo[];
}): Promise<ActionResult<number>> {
  const { data, error } = await createClient().rpc("record_payment", {
    p_creator: input.creatorId,
    p_amount: input.amount,
    p_doc_path: input.docPath,
    p_doc_name: input.docName,
    p_note: input.note,
    p_videos: input.videos,
  });
  if (error) {
    return fail(isRaised(error) ? error.message : tr("api.paymentFailed", { message: error.message }));
  }
  return { ok: true, data: data as number };
}

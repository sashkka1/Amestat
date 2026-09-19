"use client";

import { useMemo, useState } from "react";
import { BanknoteIcon, ClockIcon, VideoIcon, WalletIcon } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { CreatorLabel } from "@/components/creator-label";
import { GONE_IMAGE_CLASS } from "@/components/gone-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MoneyTiles, type MoneyTile } from "./money-tiles";
import { PayDialog } from "./pay-dialog";
import { PaymentHistory } from "./payment-history";
import { RulesPanel } from "./rules-panel";
import { VideosMoneyTable, type VideoMoneyRow } from "./videos-money-table";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { coveredVideos, fmtMoney, videoMoney, type CreatorMoney } from "@/lib/payment";
import type { Creator, Payment, PaymentStat, PaymentVideo } from "@/lib/types";

// Попап креатора на вкладке «Payments». Раскладка — та, что просил владелец: слева сверху
// иконка, правее от неё статистика по этому креатору, под статистикой видео таблицей, а
// слева — параметры, по которым считается оплата, и история выплат под ними.
export function CreatorPaymentSheet({
  creator,
  money,
  stats,
  payments,
  covers,
  onClose,
  onChanged,
}: {
  creator: Creator;
  money: CreatorMoney;
  stats: PaymentStat[];
  payments: Payment[];
  covers: PaymentVideo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [paying, setPaying] = useState(false);
  const name = creator.display_name || creator.handle;

  const rows: VideoMoneyRow[] = useMemo(
    () => stats.map((stat) => ({ stat, money: videoMoney(stat, money.rules) })),
    [stats, money.rules],
  );
  const covered = useMemo(
    () => coveredVideos(creator.id, stats, money.rules),
    [creator.id, stats, money.rules],
  );

  const tiles: MoneyTile[] = [
    { key: "paid", label: t("payments.paidTotal"), value: fmtMoney(money.paidTotal), icon: WalletIcon },
    {
      key: "due",
      label: t("payments.dueNow"),
      value: fmtMoney(money.due),
      icon: BanknoteIcon,
      tone: money.due > 0 ? "due" : "plain",
      hint: money.gateOpen ? undefined : t("payments.gateClosed", { n: money.rules.videos_threshold }),
      onClick: () => setPaying(true),
    },
    { key: "pending", label: t("payments.pending"), value: fmtMoney(money.pendingTotal), icon: ClockIcon },
    {
      key: "videos",
      label: t("payments.colVideos"),
      value: fmtNum(money.videos),
      icon: VideoIcon,
      hint: money.gateOpen
        ? `${t("payments.videosFinal")}: ${money.videosFinal + money.videosPaid} · ${t("payments.videosNoData")}: ${money.videosNoData}`
        : t("payments.gateLeft", { n: money.videosToGate }),
    },
  ];

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-[76rem]">
          <DialogTitle className="sr-only">{t("payments.payTitle", { name })}</DialogTitle>
          <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
            {/* Левая колонка: кто это, по каким ставкам считаем и что уже платили. */}
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex items-center gap-3">
                <Avatar
                  src={creator.avatar_url}
                  name={name}
                  size={56}
                  className={creator.gone_at ? GONE_IMAGE_CLASS : undefined}
                />
                <div className="min-w-0">
                  <CreatorLabel
                    platform={creator.platform}
                    name={creator.display_name}
                    handle={creator.handle}
                    className="text-base font-semibold"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("payments.historyFor", {
                      n: money.videos,
                      videos: t.plural("videos", money.videos),
                    })}
                  </p>
                </div>
              </div>
              <RulesPanel creatorId={creator.id} rules={money.rules} onSaved={onChanged} />
              <PaymentHistory payments={payments} covers={covers} />
            </div>

            {/* Правая колонка: деньги по этому креатору и его видео. */}
            <div className="flex min-w-0 flex-col gap-4">
              <MoneyTiles items={tiles} />
              <div className="flex justify-end">
                <Button onClick={() => setPaying(true)} disabled={covered.length === 0 && money.due <= 0}>
                  <BanknoteIcon data-icon="inline-start" />
                  {t("payments.pay")}
                </Button>
              </div>
              <VideosMoneyTable rows={rows} gateOpen={money.gateOpen} />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Окно выплаты — рядом с попапом, а не внутри него: вложенный в чужой Dialog корень
          закрывался бы вместе с ним, не успев показать ошибку. */}
      <PayDialog
        open={paying}
        onOpenChange={setPaying}
        creatorId={creator.id}
        creatorName={name}
        due={money.due}
        covered={covered}
        onPaid={onChanged}
      />
    </>
  );
}

// Значков площадок в lucide больше нет (брендовые убраны в 1.x), поэтому берём близкие
// по смыслу: нота — TikTok, камера — Instagram.
import { CameraIcon, Music2Icon } from "lucide-react";
import type { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

const LABEL: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram" };

export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const Icon = platform === "instagram" ? CameraIcon : Music2Icon;
  return <Icon className={cn("size-3.5 text-muted-foreground", className)} aria-label={LABEL[platform]} />;
}

// Пилюля «TikTok» в таблицах.
export function PlatformChip({ platform }: { platform: Platform }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
      <PlatformIcon platform={platform} />
      {LABEL[platform]}
    </span>
  );
}

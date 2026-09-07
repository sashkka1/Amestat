"use client";

import Image from "next/image";
import { useState } from "react";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

// Аватар с заглушкой-инициалами: адреса TikTok CDN протухают, картинка может не загрузиться.
export function Avatar({
  src,
  name,
  size = 48,
  height,
  className,
  rounded = "full",
}: {
  src: string | null | undefined;
  name: string;
  size?: number;
  height?: number;
  className?: string;
  rounded?: "full" | "md";
}) {
  const h = height ?? size;
  // Запоминаем, какой именно адрес не загрузился: сменился адрес — пробуем снова.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== undefined && src !== null && failedSrc === src;

  const shape = rounded === "full" ? "rounded-full" : "rounded-md";
  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex shrink-0 select-none items-center justify-center bg-muted font-medium text-muted-foreground",
          shape,
          className,
        )}
        style={{ width: size, height: h, fontSize: Math.max(11, size * 0.36) }}
        aria-label={name}
      >
        {initials(name)}
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt={name}
      width={size}
      height={h}
      unoptimized
      onError={() => setFailedSrc(src)}
      className={cn("shrink-0 object-cover bg-muted", shape, className)}
      style={{ width: size, height: h }}
    />
  );
}

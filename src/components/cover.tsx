"use client";

import { useState } from "react";
import { ImageOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Обложка видео 9:16. Адреса TikTok CDN протухают, поэтому при ошибке — заглушка.
export function Cover({
  src,
  width,
  className,
}: {
  src: string | null;
  width: number;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const height = Math.round((width * 16) / 9);
  const failed = src !== null && failedSrc === src;

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
          className,
        )}
        style={{ width, height }}
      >
        <ImageOffIcon className="size-4" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={width}
      height={height}
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className={cn("shrink-0 rounded-lg bg-muted object-cover", className)}
      style={{ width, height }}
    />
  );
}

import type { NextConfig } from "next";

// Сайт — статика для GitHub Pages: сервера нет, всё крутится в браузере против Supabase.
// NEXT_PUBLIC_BASE_PATH — подпуть на github.io (`/<repo>`); локально пустой.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: {
    // Оптимизатора картинок в статике нет; адреса TikTok CDN и так живут недолго.
    unoptimized: true,
  },
};

export default nextConfig;

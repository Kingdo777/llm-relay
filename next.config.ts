import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是 native 模块，不能被 webpack 打包
  serverExternalPackages: ["better-sqlite3"],
  // 运行时允许的请求体大小（LLM 请求可能较大）
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;

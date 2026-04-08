import type { NextConfig } from "next";

const apiCorsAllowOrigin =
  process.env.API_CORS_ALLOW_ORIGIN ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "*";

const nextConfig: NextConfig = {
  // Evita que Next intente inferir un root superior por lockfiles externos.
  outputFileTracingRoot: process.cwd(),
  /**
   * Cabeceras de seguridad y CORS para la API REST.
   * Permite restringir origen en produccion via API_CORS_ALLOW_ORIGIN.
   */
  async headers() {
    return [
      {
        source: "/api/v1/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: apiCorsAllowOrigin,
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization, X-Request-Id",
          },
          {
            key: "Access-Control-Max-Age",
            value: "86400",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

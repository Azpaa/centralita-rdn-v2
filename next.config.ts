import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Cabeceras de seguridad y CORS para la API REST.
   * Permite que el sistema RDN haga peticiones cross-origin a /api/v1/*.
   */
  async headers() {
    return [
      {
        // CORS para la API REST (RDN u otros sistemas M2M)
        source: "/api/v1/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            // En producción se puede restringir al dominio de RDN.
            // Por ahora, solo requests autenticadas con API Key.
            value: "*",
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
        // Cabeceras de seguridad globales
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

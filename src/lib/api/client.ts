/**
 * Helper para llamadas a la API interna desde componentes client.
 * Usa fetch relativo (misma app Next.js).
 */

const API_BASE = '/api/v1';

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data: T;
  meta?: { page: number; limit: number; total: number; totalPages: number };
  error?: string;
  details?: unknown;
}

async function request<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (res.status === 204) {
    return { ok: true, data: null as T };
  }

  const json = await res.json();
  return {
    ok: res.ok,
    data: json.data as T,
    meta: json.meta,
    error: json.error?.message ?? json.error,
    details: json.error?.details,
  };
}

export const api = {
  get: <T = unknown>(path: string) => request<T>(path),
  post: <T = unknown>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T = unknown>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T = unknown>(path: string) =>
    request<T>(path, { method: 'DELETE' }),
};

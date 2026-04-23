/**
 * Helper para llamadas a la API interna desde componentes client.
 * Usa fetch relativo (misma app Next.js).
 *
 * Incluye:
 * - Timeout configurable (por defecto 15 s)
 * - Abort controller para cancelar peticiones
 * - Retry automático con back-off exponencial en errores transitorios
 * - Deduplicación de GETs idénticos en vuelo
 * - Credentials same-origin (cookies de sesión Supabase)
 */

const API_BASE = '/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data: T;
  meta?: { page: number; limit: number; total: number; totalPages: number };
  error?: string;
  details?: unknown;
}

export interface RequestOptions extends Omit<RequestInit, 'signal'> {
  /** Tiempo máximo en ms antes de abortar (defecto 15 000) */
  timeout?: number;
  /** AbortSignal externo (ej. useEffect cleanup) */
  signal?: AbortSignal;
  /** Desactivar retry para esta petición */
  noRetry?: boolean;
}

// Cache de GETs en vuelo para deduplicar
const inflightGets = new Map<string, Promise<ApiResponse<unknown>>>();

async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
  attempt = 0,
): Promise<ApiResponse<T>> {
  const { timeout = DEFAULT_TIMEOUT_MS, signal: externalSignal, noRetry, ...fetchOpts } = options;

  // Combinar timeout interno con signal externo
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), timeout);

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      return { ok: false, data: null as T, error: 'Petición cancelada' };
    }
    externalSignal.addEventListener('abort', () => controller.abort('canceled'), { once: true });
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      ...fetchOpts,
      headers: {
        'Content-Type': 'application/json',
        ...fetchOpts.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.status === 204) {
      return { ok: true, data: null as T };
    }

    // Retry en errores transitorios (solo idempotentes o con flag)
    if (
      !noRetry &&
      RETRYABLE_STATUS.has(res.status) &&
      attempt < MAX_RETRIES &&
      (!fetchOpts.method || fetchOpts.method === 'GET')
    ) {
      const delay = RETRY_DELAY_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      return request<T>(path, options, attempt + 1);
    }

    const json = await res.json();
    return {
      ok: res.ok,
      data: json.data as T,
      meta: json.meta,
      error: json.error?.message ?? json.error,
      details: json.error?.details,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, data: null as T, error: 'Petición cancelada o timeout' };
    }

    // Retry en errores de red
    if (!noRetry && attempt < MAX_RETRIES && (!fetchOpts.method || fetchOpts.method === 'GET')) {
      const delay = RETRY_DELAY_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      return request<T>(path, options, attempt + 1);
    }

    return {
      ok: false,
      data: null as T,
      error: err instanceof Error ? err.message : 'Error de red desconocido',
    };
  }
}

/** GET con deduplicación de peticiones en vuelo */
function deduplicatedGet<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
  const key = path;
  const existing = inflightGets.get(key);
  if (existing) return existing as Promise<ApiResponse<T>>;

  const promise = request<T>(path, options).finally(() => inflightGets.delete(key));
  inflightGets.set(key, promise as Promise<ApiResponse<unknown>>);
  return promise;
}

export const api = {
  get: <T = unknown>(path: string, options?: RequestOptions) => deduplicatedGet<T>(path, options),
  post: <T = unknown>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) }),
  put: <T = unknown>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) }),
  patch: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T = unknown>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

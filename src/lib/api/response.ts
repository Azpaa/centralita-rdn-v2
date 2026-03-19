import { NextResponse } from 'next/server';

// --- Tipos ---

export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

// --- Respuestas de éxito ---

export function apiSuccess(data: unknown, meta?: ApiMeta, status = 200) {
  const body: Record<string, unknown> = { ok: true, data };
  if (meta) body.meta = meta;
  return NextResponse.json(body, { status });
}

export function apiCreated(data: unknown) {
  return apiSuccess(data, undefined, 201);
}

export function apiNoContent() {
  return new NextResponse(null, { status: 204 });
}

// --- Respuestas de error ---

export function apiError(status: number, code: string, message: string, details?: unknown) {
  const error: ApiErrorBody = { code, message };
  if (details) error.details = details;
  return NextResponse.json({ error }, { status });
}

export function apiNotFound(entity = 'Recurso') {
  return apiError(404, 'NOT_FOUND', `${entity} no encontrado`);
}

export function apiBadRequest(message: string, details?: unknown) {
  return apiError(400, 'BAD_REQUEST', message, details);
}

export function apiUnauthorized(message = 'No autorizado') {
  return apiError(401, 'UNAUTHORIZED', message);
}

export function apiForbidden(message = 'Acceso denegado') {
  return apiError(403, 'FORBIDDEN', message);
}

export function apiConflict(message: string) {
  return apiError(409, 'CONFLICT', message);
}

export function apiInternalError(message = 'Error interno del servidor') {
  return apiError(500, 'INTERNAL_ERROR', message);
}

// --- Paginación ---

export function parsePagination(searchParams: URLSearchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
  return { page, limit, skip: (page - 1) * limit };
}

export function buildMeta(page: number, limit: number, total: number): ApiMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

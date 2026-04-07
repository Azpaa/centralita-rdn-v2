import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Rutas públicas:
 * - /login: página de autenticación
 * - /change-password: cambio de contraseña obligatorio (requiere sesión, pero
 *   está exenta del chequeo must_change_password para no crear un loop)
 * - /api/webhooks/: webhooks de Twilio (validados con X-Twilio-Signature)
 * - /api/v1/: API REST (cada ruta tiene su propio authenticate() que acepta
 *   sesión Supabase O API key; el proxy no puede validar API keys, así que
 *   las dejamos pasar y la ruta se encarga)
 * - /api/health: healthcheck
 */
const publicRoutes = [
  '/login',
  '/change-password',
  '/api/webhooks/',
  '/api/v1/',
  '/api/health',
  '/voice-agent/download',
  '/downloads/',
]

const defaultDesktopOrigins = ['tauri://localhost', 'http://localhost:1420', 'http://127.0.0.1:1420']

function getAllowedDesktopOrigins(): string[] {
  const fromEnv = (process.env.TAURI_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set([...defaultDesktopOrigins, ...fromEnv])]
}

function isDesktopOriginAllowed(origin: string | null): origin is string {
  if (!origin) return false
  return getAllowedDesktopOrigins().includes(origin)
}

function applyApiCorsHeaders(response: NextResponse, origin: string | null) {
  if (!isDesktopOriginAllowed(origin)) return

  response.headers.set('Access-Control-Allow-Origin', origin)
  response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept')
  response.headers.set('Access-Control-Expose-Headers', 'Content-Type,X-Request-Id')
  response.headers.set('Vary', 'Origin')
}

function isPublicRoute(pathname: string): boolean {
  return publicRoutes.some((route) => pathname.startsWith(route))
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const requestOrigin = request.headers.get('origin')

  if (pathname.startsWith('/api/v1/') && request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, { status: 204 })
    applyApiCorsHeaders(preflight, requestOrigin)
    return preflight
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Allow public routes
  if (isPublicRoute(pathname)) {
    // Redirect authenticated users away from login
    if (pathname === '/login' && user) {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      return NextResponse.redirect(url)
    }
    if (pathname.startsWith('/api/v1/')) {
      applyApiCorsHeaders(supabaseResponse, requestOrigin)
    }
    return supabaseResponse
  }

  // Protect all other routes
  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(url)
  }

  if (pathname.startsWith('/api/v1/')) {
    applyApiCorsHeaders(supabaseResponse, requestOrigin)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

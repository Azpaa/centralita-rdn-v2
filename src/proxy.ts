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
const publicRoutes = ['/login', '/change-password', '/api/webhooks/', '/api/v1/', '/api/health']

function isPublicRoute(pathname: string): boolean {
  return publicRoutes.some((route) => pathname.startsWith(route))
}

export async function proxy(request: NextRequest) {
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

  const { pathname } = request.nextUrl

  // Allow public routes
  if (isPublicRoute(pathname)) {
    // Redirect authenticated users away from login
    if (pathname === '/login' && user) {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      return NextResponse.redirect(url)
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

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

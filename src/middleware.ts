/**
 * Next.js Middleware — punto de entrada que Next.js ejecuta automáticamente.
 * Re-exporta la lógica del proxy de autenticación.
 *
 * IMPORTANTE: Next.js solo reconoce `middleware.ts` en la raíz de `src/`
 * (o raíz del proyecto). Sin este archivo, proxy.ts no se ejecuta nunca.
 */
export { proxy as middleware, config } from './proxy';

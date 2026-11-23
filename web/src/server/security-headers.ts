/**
 * S0-4 (SEC-16): response hardening for the local UI. The app renders agent-authored Markdown and
 * Mermaid diagrams; raw HTML is not rendered and Mermaid runs in strict mode, so the CSP is defence
 * in depth against a dependency bypass rather than the primary control. `upgrade-insecure-requests`
 * is deliberately absent: the app is served over plain HTTP on loopback.
 *
 * Kept as plain functions so the policy string is unit-testable and shared between `next.config.ts`
 * (which applies it) and the tests.
 */
export function contentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    // Next.js emits inline bootstrap scripts; without nonces (which would force dynamic rendering
    // and fight Mantine's inline styles) 'unsafe-inline' is what keeps the app working. The policy
    // still forbids third-party scripts and plugins.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Same-origin fetch and the SSE watch stream; websockets are only needed by the dev HMR client.
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
  ].join("; ");
}

export interface ResponseHeader {
  key: string;
  value: string;
}

export function securityHeaders(isDev: boolean): ResponseHeader[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
}

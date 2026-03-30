export interface Env {
  DASHBOARD_KV: KVNamespace;
  DASHBOARD_TOKEN: string;
}

const COOKIE_NAME = "egg_session";
const COOKIE_MAX_AGE = 2592000; // 30 days in seconds

export type AuthMethod = "cookie" | "header" | "param";

export interface AuthResult {
  valid: boolean;
  method: AuthMethod | null;
}

/**
 * Authenticate the request.
 * Checks (in order): session cookie, Authorization header, ?token= query param.
 */
export function authenticate(request: Request, env: Env): AuthResult {
  const expected = env.DASHBOARD_TOKEN;
  if (!expected) return { valid: false, method: null };

  // 1. Session cookie (long-lived, set on first valid ?token= visit)
  const cookies = request.headers.get("Cookie") ?? "";
  const cookieMatch = cookies.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`),
  );
  if (cookieMatch && cookieMatch[1] === expected) {
    return { valid: true, method: "cookie" };
  }

  // 2. Authorization: Bearer <token>
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && bearerMatch[1] === expected) {
      return { valid: true, method: "header" };
    }
  }

  // 3. ?token= query param (for iMessage links)
  const url = new URL(request.url);
  const paramToken = url.searchParams.get("token");
  if (paramToken && paramToken === expected) {
    return { valid: true, method: "param" };
  }

  return { valid: false, method: null };
}

/** Build a Set-Cookie header value for a 30-day session. */
export function sessionCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/** Return the URL with the ?token= param stripped. */
export function stripTokenParam(url: URL): string {
  const clean = new URL(url.toString());
  clean.searchParams.delete("token");
  return clean.toString();
}

export function unauthorizedResponse(): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unauthorized</title>
  <style>
    body { background: #0a0a0a; color: #888; font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .msg { text-align: center; }
    h1 { color: #ccc; font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="msg">
    <h1>401 Unauthorized</h1>
    <p>Valid token required.</p>
  </div>
</body>
</html>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

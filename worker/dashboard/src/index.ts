import {
  authenticate,
  unauthorizedResponse,
  sessionCookieHeader,
  stripTokenParam,
} from "./auth.js";
import type { Env } from "./auth.js";
import { handlePush, handleSnapshot, getSnapshot } from "./api.js";
import { renderDashboard } from "./dashboard.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = authenticate(request, env);

    if (!auth.valid) {
      return unauthorizedResponse();
    }

    // First visit via ?token= link: set a 30-day session cookie and redirect
    // to the clean URL so the token isn't stuck in browser history / link previews.
    if (auth.method === "param" && request.method === "GET") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: stripTokenParam(url),
          "Set-Cookie": sessionCookieHeader(env.DASHBOARD_TOKEN),
        },
      });
    }

    // For non-GET requests authed via param (e.g. API calls), set the cookie
    // on the response so future requests are also covered.
    const setCookie =
      auth.method === "param"
        ? sessionCookieHeader(env.DASHBOARD_TOKEN)
        : null;

    // Route
    if (request.method === "POST" && url.pathname === "/api/push") {
      const res = await handlePush(request, env);
      if (setCookie) res.headers.set("Set-Cookie", setCookie);
      return res;
    }

    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      const res = await handleSnapshot(env);
      if (setCookie) res.headers.set("Set-Cookie", setCookie);
      return res;
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const snapshot = await getSnapshot(env);
      const html = renderDashboard(snapshot);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

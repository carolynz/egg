import { validateToken, unauthorizedResponse } from "./auth.js";
import type { Env } from "./auth.js";
import { handlePush, handleSnapshot, getSnapshot } from "./api.js";
import { renderDashboard } from "./dashboard.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // All routes require auth
    if (!validateToken(request, env)) {
      return unauthorizedResponse();
    }

    // Extract token for passing to rendered pages (for link continuity)
    const token = url.searchParams.get("token") ?? "";

    // Route
    if (request.method === "POST" && url.pathname === "/api/push") {
      return handlePush(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      return handleSnapshot(env);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const snapshot = await getSnapshot(env);
      const html = renderDashboard(snapshot, token);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

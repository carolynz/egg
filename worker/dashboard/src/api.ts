import type { Env } from "./auth.js";

const KV_KEY = "financial_snapshot";

export interface FinancialSnapshot {
  pulledAt: string;
  orgs: Array<{
    label: string;
    accounts: Array<{
      id: string;
      name: string;
      kind: string;
      currentBalance: number;
      availableBalance: number;
    }>;
    totalBalance: number;
    recentTransactions: Array<{
      id: string;
      amount: number;
      status: string;
      counterpartyName: string;
      note: string | null;
      createdAt: string;
      postedDate: string | null;
      kind: string;
      dashboardLink: string;
      externalMemo: string | null;
    }>;
  }>;
  totalBalance: number;
  summary: {
    totalBalance: string;
    orgBreakdown: Array<{
      label: string;
      balance: string;
      accounts: Array<{ name: string; kind: string; balance: string }>;
    }>;
    largeTransactions: Array<{ counterparty: string; amount: string; date: string; kind: string }>;
    netCashFlow: string;
    periodStart: string;
    periodEnd: string;
  };
}

/** POST /api/push — store a financial snapshot in KV */
export async function handlePush(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as FinancialSnapshot;

    if (!body.pulledAt || !body.orgs || typeof body.totalBalance !== "number") {
      return Response.json({ error: "Invalid snapshot format" }, { status: 400 });
    }

    // Store with metadata for TTL tracking (no expiration — egg controls freshness)
    await env.DASHBOARD_KV.put(KV_KEY, JSON.stringify(body), {
      metadata: { pushedAt: new Date().toISOString() },
    });

    return Response.json({ ok: true, pushedAt: new Date().toISOString() });
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

/** GET /api/snapshot — return the current snapshot as JSON */
export async function handleSnapshot(env: Env): Promise<Response> {
  const data = await env.DASHBOARD_KV.get(KV_KEY);
  if (!data) {
    return Response.json({ error: "No snapshot available" }, { status: 404 });
  }
  return new Response(data, {
    headers: { "Content-Type": "application/json" },
  });
}

/** Read snapshot from KV (used by dashboard renderer) */
export async function getSnapshot(env: Env): Promise<FinancialSnapshot | null> {
  const data = await env.DASHBOARD_KV.get(KV_KEY);
  if (!data) return null;
  return JSON.parse(data) as FinancialSnapshot;
}

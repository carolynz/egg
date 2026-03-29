import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { EGG_MEMORY_DIR } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface MercuryAccount {
  id: string;
  name: string;
  kind: string;        // "checking" | "savings" etc.
  status: string;
  currentBalance: number;
  availableBalance: number;
  routingNumber: string;
  accountNumber: string;
}

interface MercuryTransaction {
  id: string;
  amount: number;
  status: string;
  counterpartyName: string;
  note: string | null;
  createdAt: string;
  postedDate: string | null;
  kind: string;         // "debit" | "credit" etc.
  dashboardLink: string;
  externalMemo: string | null;
}

interface MercuryAccountsResponse {
  accounts: MercuryAccount[];
}

interface MercuryTransactionsResponse {
  total: number;
  transactions: MercuryTransaction[];
}

interface MercurySnapshot {
  pulledAt: string;
  accounts: Array<{
    id: string;
    name: string;
    kind: string;
    currentBalance: number;
    availableBalance: number;
  }>;
  totalBalance: number;
  recentTransactions: MercuryTransaction[];
  summary: {
    totalBalance: string;
    accountBreakdown: Array<{ name: string; kind: string; balance: string }>;
    largeTransactions: Array<{ counterparty: string; amount: string; date: string; kind: string }>;
    netCashFlow: string;
    periodStart: string;
    periodEnd: string;
  };
}

// ── API helpers ──────────────────────────────────────────────────────────────

const MERCURY_BASE = "https://api.mercury.com/api/v1";

function getToken(): string {
  const token = process.env.MERCURY_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing MERCURY_API_TOKEN environment variable.\n" +
      "Set it in your .env file or shell:\n" +
      "  export MERCURY_API_TOKEN=your-mercury-api-key\n" +
      "Get your API token from Mercury dashboard → Settings → API Tokens."
    );
  }
  return token;
}

async function mercuryGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${MERCURY_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mercury API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Fetch accounts ───────────────────────────────────────────────────────────

async function fetchAccounts(token: string): Promise<MercuryAccount[]> {
  const data = await mercuryGet<MercuryAccountsResponse>("/accounts", token);
  return data.accounts;
}

// ── Fetch transactions for an account (last 30 days) ─────────────────────────

async function fetchTransactions(
  token: string,
  accountId: string,
  start: string,
  end: string,
): Promise<MercuryTransaction[]> {
  const all: MercuryTransaction[] = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const params = new URLSearchParams({
      start,
      end,
      limit: String(limit),
      offset: String(offset),
    });
    const data = await mercuryGet<MercuryTransactionsResponse>(
      `/account/${accountId}/transactions?${params}`,
      token,
    );
    all.push(...data.transactions);
    if (all.length >= data.total || data.transactions.length < limit) break;
    offset += limit;
  }

  return all;
}

// ── Format currency ──────────────────────────────────────────────────────────

function fmtUsd(cents: number): string {
  // Mercury API returns amounts in dollars (not cents)
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Main intake function ─────────────────────────────────────────────────────

export async function intakeMercury(): Promise<void> {
  const token = getToken();

  console.log("[mercury] Fetching accounts...");
  const accounts = await fetchAccounts(token);
  console.log(`[mercury] Found ${accounts.length} account(s)`);

  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const startDate = thirtyDaysAgo.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  // Fetch transactions across all accounts
  const allTransactions: MercuryTransaction[] = [];
  for (const acct of accounts) {
    console.log(`[mercury] Fetching transactions for ${acct.name} (${acct.kind})...`);
    const txns = await fetchTransactions(token, acct.id, startDate, endDate);
    console.log(`[mercury]   ${txns.length} transactions`);
    allTransactions.push(...txns);
  }

  // Sort transactions by date (newest first)
  allTransactions.sort((a, b) => {
    const dateA = a.postedDate ?? a.createdAt;
    const dateB = b.postedDate ?? b.createdAt;
    return dateB.localeCompare(dateA);
  });

  // Calculate totals
  const totalBalance = accounts.reduce((sum, a) => sum + a.currentBalance, 0);

  // Net cash flow for the period
  const netCashFlow = allTransactions.reduce((sum, t) => sum + t.amount, 0);

  // Large transactions (>$500 absolute value)
  const largeTransactions = allTransactions.filter((t) => Math.abs(t.amount) > 500);

  // Build summary
  const summary = {
    totalBalance: fmtUsd(totalBalance),
    accountBreakdown: accounts.map((a) => ({
      name: a.name,
      kind: a.kind,
      balance: fmtUsd(a.currentBalance),
    })),
    largeTransactions: largeTransactions.slice(0, 20).map((t) => ({
      counterparty: t.counterpartyName,
      amount: fmtUsd(t.amount),
      date: t.postedDate ?? t.createdAt,
      kind: t.kind,
    })),
    netCashFlow: fmtUsd(netCashFlow),
    periodStart: startDate,
    periodEnd: endDate,
  };

  const snapshot: MercurySnapshot = {
    pulledAt: now.toISOString(),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      currentBalance: a.currentBalance,
      availableBalance: a.availableBalance,
    })),
    totalBalance,
    recentTransactions: allTransactions,
    summary,
  };

  // Write to data/finance/mercury.json
  const financeDir = join(EGG_MEMORY_DIR, "data", "finance");
  mkdirSync(financeDir, { recursive: true });
  const outPath = join(financeDir, "mercury.json");
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`[mercury] Wrote ${outPath}`);
  console.log(`[mercury] Total balance: ${summary.totalBalance}`);
  console.log(`[mercury] Net cash flow (30d): ${summary.netCashFlow}`);
  console.log(`[mercury] Large transactions (>$500): ${largeTransactions.length}`);
  console.log("[mercury] Done.");
}

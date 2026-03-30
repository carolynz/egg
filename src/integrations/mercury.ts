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
    recentTransactions: MercuryTransaction[];
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

// ── API helpers ──────────────────────────────────────────────────────────────

const MERCURY_BASE = "https://api.mercury.com/api/v1";

/**
 * Collect Mercury API tokens from environment variables.
 * Supports two conventions:
 *   1. MERCURY_TOKENS — comma-separated list of tokens
 *   2. MERCURY_TOKEN_1, MERCURY_TOKEN_2, ... — numbered tokens
 * At least one token must be provided.
 */
function getTokens(): string[] {
  const tokens: string[] = [];

  // Convention 1: comma-separated list
  const csv = process.env.MERCURY_TOKENS;
  if (csv) {
    tokens.push(...csv.split(",").map((t) => t.trim()).filter(Boolean));
  }

  // Convention 2: numbered env vars
  for (let i = 1; i <= 20; i++) {
    const t = process.env[`MERCURY_TOKEN_${i}`];
    if (t) tokens.push(t.trim());
  }

  if (tokens.length === 0) {
    throw new Error(
      "No Mercury API tokens found.\n" +
      "Set MERCURY_TOKENS (comma-separated) or MERCURY_TOKEN_1, MERCURY_TOKEN_2, … in your .env file.\n" +
      "Get API tokens from Mercury dashboard → Settings → API Tokens."
    );
  }

  return tokens;
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
  const tokens = getTokens();
  console.log(`[mercury] Found ${tokens.length} org token(s)`);

  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const startDate = thirtyDaysAgo.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const orgs: MercurySnapshot["orgs"] = [];
  const allTransactions: MercuryTransaction[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const label = `org-${i + 1}`;

    console.log(`[mercury] Fetching accounts for ${label}...`);
    const accounts = await fetchAccounts(token);
    console.log(`[mercury]   ${accounts.length} account(s)`);

    const orgTransactions: MercuryTransaction[] = [];
    for (const acct of accounts) {
      console.log(`[mercury]   Fetching transactions for ${acct.kind} account...`);
      const txns = await fetchTransactions(token, acct.id, startDate, endDate);
      console.log(`[mercury]     ${txns.length} transactions`);
      orgTransactions.push(...txns);
    }

    const orgBalance = accounts.reduce((sum, a) => sum + a.currentBalance, 0);

    orgs.push({
      label,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        currentBalance: a.currentBalance,
        availableBalance: a.availableBalance,
      })),
      totalBalance: orgBalance,
      recentTransactions: orgTransactions,
    });

    allTransactions.push(...orgTransactions);
  }

  // Sort transactions by date (newest first)
  allTransactions.sort((a, b) => {
    const dateA = a.postedDate ?? a.createdAt;
    const dateB = b.postedDate ?? b.createdAt;
    return dateB.localeCompare(dateA);
  });

  // Calculate totals
  const totalBalance = orgs.reduce((sum, o) => sum + o.totalBalance, 0);
  const netCashFlow = allTransactions.reduce((sum, t) => sum + t.amount, 0);
  const largeTransactions = allTransactions.filter((t) => Math.abs(t.amount) > 500);

  // Build summary
  const summary = {
    totalBalance: fmtUsd(totalBalance),
    orgBreakdown: orgs.map((o) => ({
      label: o.label,
      balance: fmtUsd(o.totalBalance),
      accounts: o.accounts.map((a) => ({
        name: a.name,
        kind: a.kind,
        balance: fmtUsd(a.currentBalance),
      })),
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
    orgs,
    totalBalance,
    summary,
  };

  // Write to egg-memory data/finance/mercury.json
  const financeDir = join(EGG_MEMORY_DIR, "data", "finance");
  mkdirSync(financeDir, { recursive: true });
  const outPath = join(financeDir, "mercury.json");
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`[mercury] Wrote snapshot to data/finance/mercury.json`);
  console.log(`[mercury] ${orgs.length} org(s), ${allTransactions.length} total transactions`);
  console.log("[mercury] Done.");
}

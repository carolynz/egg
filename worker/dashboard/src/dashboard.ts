import type { FinancialSnapshot } from "./api.js";

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function weekLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  return `Week of ${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

interface Transaction {
  amount: number;
  counterpartyName: string;
  postedDate: string | null;
  createdAt: string;
  kind: string;
}

function renderTransactionRows(txns: Transaction[]): string {
  return txns.map((t) => {
    const date = t.postedDate ?? t.createdAt;
    const shortDate = new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const isInflow = t.amount > 0;
    const cls = isInflow ? "inflow" : "outflow";
    return `<tr>
      <td class="date">${shortDate}</td>
      <td class="counterparty">${escapeHtml(t.counterpartyName)}</td>
      <td class="amount ${cls}">${fmtUsd(t.amount)}</td>
    </tr>`;
  }).join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderDashboard(snapshot: FinancialSnapshot | null): string {
  if (!snapshot) {
    return noDataPage();
  }

  const { orgs, totalBalance, summary } = snapshot;

  // Compute monthly cash flow
  const allTxns: Transaction[] = [];
  for (const org of orgs) {
    allTxns.push(...org.recentTransactions);
  }
  allTxns.sort((a, b) => {
    const da = a.postedDate ?? a.createdAt;
    const db = b.postedDate ?? b.createdAt;
    return db.localeCompare(da);
  });

  const inflows = allTxns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflows = allTxns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const netFlow = inflows + outflows;
  const monthlyBurn = Math.abs(outflows);
  const runwayMonths = monthlyBurn > 0 ? totalBalance / monthlyBurn : Infinity;

  // Group transactions by week (most recent 50)
  const recentTxns = allTxns.slice(0, 50);
  const weeks = new Map<string, Transaction[]>();
  for (const t of recentTxns) {
    const date = t.postedDate ?? t.createdAt;
    const label = weekLabel(date);
    if (!weeks.has(label)) weeks.set(label, []);
    weeks.get(label)!.push(t);
  }

  // Org cards
  const orgCards = orgs.map((org) => {
    const accountRows = org.accounts.map((a) => `
      <div class="account-row">
        <span class="account-name">${escapeHtml(a.name)} <span class="badge">${a.kind}</span></span>
        <span class="account-bal">${fmtUsd(a.currentBalance)}</span>
      </div>
    `).join("");
    return `
      <div class="card org-card">
        <h3>${escapeHtml(org.label)}</h3>
        <div class="org-total">${fmtUsd(org.totalBalance)}</div>
        ${accountRows}
      </div>`;
  }).join("");

  // Transaction weeks
  const weekSections = Array.from(weeks.entries()).map(([label, txns]) => `
    <div class="week-group">
      <h4>${label}</h4>
      <table>${renderTransactionRows(txns)}</table>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Financial Dashboard</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Financial Dashboard</h1>
      <p class="updated">Updated ${relativeTime(snapshot.pulledAt)} &middot; ${new Date(snapshot.pulledAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
    </header>

    <section class="hero">
      <div class="hero-label">Total Liquid Cash</div>
      <div class="hero-amount">${fmtUsd(totalBalance)}</div>
    </section>

    <section class="metrics">
      <div class="card metric">
        <div class="metric-label">Inflows (30d)</div>
        <div class="metric-value inflow">${fmtUsd(inflows)}</div>
      </div>
      <div class="card metric">
        <div class="metric-label">Outflows (30d)</div>
        <div class="metric-value outflow">${fmtUsd(outflows)}</div>
      </div>
      <div class="card metric">
        <div class="metric-label">Net Cash Flow</div>
        <div class="metric-value ${netFlow >= 0 ? "inflow" : "outflow"}">${fmtUsd(netFlow)}</div>
      </div>
      <div class="card metric">
        <div class="metric-label">Runway</div>
        <div class="metric-value">${runwayMonths === Infinity ? "\u221e" : runwayMonths.toFixed(1) + " mo"}</div>
      </div>
    </section>

    <section class="orgs">
      <h2>Cash Position by Organization</h2>
      <div class="org-grid">${orgCards}</div>
    </section>

    <section class="transactions">
      <h2>Recent Transactions</h2>
      <p class="period">${summary.periodStart} \u2013 ${summary.periodEnd}</p>
      ${weekSections}
    </section>
  </div>
</body>
</html>`;
}

function noDataPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Financial Dashboard</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Financial Dashboard</h1>
    </header>
    <section class="hero">
      <div class="hero-label">No data yet</div>
      <p class="hint">Run <code>egg push dashboard</code> to populate.</p>
    </section>
  </div>
</body>
</html>`;
}

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .container {
    max-width: 600px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  header { margin-bottom: 1.5rem; }
  h1 { font-size: 1.4rem; font-weight: 600; color: #fff; }
  h2 { font-size: 1.1rem; font-weight: 600; color: #ccc; margin-bottom: 0.75rem; }
  h3 { font-size: 0.95rem; font-weight: 600; color: #bbb; margin-bottom: 0.5rem; }
  h4 { font-size: 0.8rem; font-weight: 500; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
  .updated { font-size: 0.8rem; color: #666; margin-top: 0.25rem; }

  .hero {
    text-align: center;
    padding: 2rem 0;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid #1a1a1a;
  }
  .hero-label { font-size: 0.85rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .hero-amount { font-size: 2.8rem; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
  .hint { color: #666; font-size: 0.9rem; margin-top: 1rem; }
  .hint code { background: #1a1a1a; padding: 0.2em 0.5em; border-radius: 4px; font-size: 0.85rem; }

  .metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 2rem;
  }
  .card {
    background: #111;
    border: 1px solid #1e1e1e;
    border-radius: 10px;
    padding: 1rem;
  }
  .metric-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.25rem; }
  .metric-value { font-size: 1.3rem; font-weight: 600; color: #fff; }
  .inflow { color: #4ade80; }
  .outflow { color: #f87171; }

  .orgs { margin-bottom: 2rem; }
  .org-grid { display: flex; flex-direction: column; gap: 0.75rem; }
  .org-card { }
  .org-total { font-size: 1.5rem; font-weight: 700; color: #fff; margin-bottom: 0.75rem; }
  .account-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0;
    border-top: 1px solid #1a1a1a;
  }
  .account-name { font-size: 0.85rem; color: #aaa; }
  .account-bal { font-size: 0.9rem; font-weight: 500; color: #ddd; }
  .badge {
    display: inline-block;
    font-size: 0.65rem;
    background: #1a1a1a;
    color: #888;
    padding: 0.1em 0.4em;
    border-radius: 3px;
    text-transform: uppercase;
    vertical-align: middle;
  }

  .transactions { margin-bottom: 2rem; }
  .period { font-size: 0.8rem; color: #666; margin-bottom: 1rem; }
  .week-group { margin-bottom: 1.25rem; }
  table { width: 100%; border-collapse: collapse; }
  tr { border-bottom: 1px solid #141414; }
  td { padding: 0.5rem 0; font-size: 0.85rem; }
  .date { color: #666; width: 4.5rem; }
  .counterparty { color: #bbb; }
  .amount { text-align: right; font-weight: 500; white-space: nowrap; }
`;

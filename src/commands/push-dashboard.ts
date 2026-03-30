import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { EGG_MEMORY_DIR } from "../config.js";

export async function pushDashboard(): Promise<void> {
  const url = process.env.DASHBOARD_URL;
  const token = process.env.DASHBOARD_TOKEN;

  if (!url) {
    throw new Error("Missing DASHBOARD_URL in .env — set to your Worker URL (e.g. https://egg-dashboard.<subdomain>.workers.dev)");
  }
  if (!token) {
    throw new Error("Missing DASHBOARD_TOKEN in .env — must match the Worker secret");
  }

  const snapshotPath = join(EGG_MEMORY_DIR, "data", "finance", "mercury.json");
  if (!existsSync(snapshotPath)) {
    throw new Error(`No Mercury snapshot found at ${snapshotPath} — run 'egg intake mercury' first`);
  }

  const snapshot = readFileSync(snapshotPath, "utf-8");

  console.log(`[push:dashboard] Pushing snapshot to ${url}/api/push ...`);

  const res = await fetch(`${url.replace(/\/+$/, "")}/api/push`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: snapshot,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Push failed (${res.status}): ${body}`);
  }

  const result = await res.json() as { ok: boolean; pushedAt: string };
  console.log(`[push:dashboard] Done — pushed at ${result.pushedAt}`);
}

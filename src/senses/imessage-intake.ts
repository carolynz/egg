import { spawn } from "child_process";
import { EGG_BRAIN, EGG_MEMORY_DIR, EGG_MODEL } from "../config.js";

export async function senseImessage(): Promise<void> {
  // TODO: Phase 3 — read broader iMessage history, group by contact,
  // call brain to summarize and update dossiers
  console.log("iMessage sense not yet implemented");
}

export async function senseDaily(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = [
    "Review the recent conversation history, people/*.md dossiers, and goals.yaml.",
    `Write a daily context digest to daily/${today}.md.`,
    "Include: notable conversations, mood signals, upcoming commitments, and anything relevant for nudge decisions.",
  ].join("\n");

  console.log("Running daily sense...");
  const child = spawn(EGG_BRAIN, ["-p", prompt, "--output-format", "text", "--model", EGG_MODEL], {
    cwd: EGG_MEMORY_DIR,
    stdio: ["ignore", "inherit", "inherit"],
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Brain exited with code ${code}`));
      else resolve();
    });
  });
}

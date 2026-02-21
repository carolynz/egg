import { spawn } from "child_process";
import { EGG_BRAIN, EGG_MEMORY_DIR } from "../config.js";

export async function callBrain(opts: {
  history: { role: string; content: string }[];
  message: string;
}): Promise<string> {
  // Format conversation history + new message as a single prompt
  const lines: string[] = [];

  if (opts.history.length > 0) {
    lines.push("Recent conversation history:");
    for (const msg of opts.history) {
      const tag = msg.role === "user" ? "[human]" : "[egg]";
      lines.push(`${tag} ${msg.content}`);
    }
    lines.push("");
  }

  lines.push(`[human] ${opts.message}`);
  lines.push("");
  lines.push("Respond as Egg. Each line of your response will be sent as a separate text message.");

  const prompt = lines.join("\n");

  const args = ["-p", prompt, "--output-format", "text"];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(EGG_BRAIN, args, {
      cwd: EGG_MEMORY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => errChunks.push(data));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        reject(new Error(`${EGG_BRAIN} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

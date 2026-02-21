import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";

/**
 * Generate an image from a text prompt.
 * Requires IMAGE_GEN_API_KEY in env.
 * IMAGE_GEN_PROVIDER defaults to "openai" (DALL-E 3).
 *
 * Returns the local file path of the downloaded image, or null on failure.
 */
export async function generateImage(prompt: string): Promise<string | null> {
  const apiKey = process.env.IMAGE_GEN_API_KEY;
  const provider = process.env.IMAGE_GEN_PROVIDER ?? "openai";

  if (!apiKey) {
    console.warn("[image-gen] IMAGE_GEN_API_KEY not set — image generation disabled");
    return null;
  }

  console.log(`[image-gen] generating via ${provider}: "${prompt.slice(0, 80)}"`);

  try {
    if (provider === "openai") {
      return await generateOpenAI(prompt, apiKey);
    }
    console.warn(`[image-gen] unknown IMAGE_GEN_PROVIDER: "${provider}" — only "openai" is supported`);
    return null;
  } catch (err) {
    console.error("[image-gen] generation failed:", err);
    return null;
  }
}

async function generateOpenAI(prompt: string, apiKey: string): Promise<string | null> {
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: "1024x1024",
      response_format: "url",
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI images API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { data?: { url?: string }[] };
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error("No image URL in OpenAI response");

  console.log(`[image-gen] downloading generated image`);
  const imgResp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);

  const buffer = Buffer.from(await imgResp.arrayBuffer());
  const outPath = join(tmpdir(), `egg-img-${Date.now()}.png`);
  writeFileSync(outPath, buffer);
  console.log(`[image-gen] saved ${buffer.length} bytes → ${outPath}`);
  return outPath;
}

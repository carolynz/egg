import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";

/**
 * Generate an image from a text prompt.
 * Requires IMAGE_GEN_API_KEY in env.
 * IMAGE_GEN_PROVIDER defaults to "gemini" (Nano Banana Pro).
 *
 * Returns the local file path of the downloaded image, or null on failure.
 */
export async function generateImage(prompt: string): Promise<string | null> {
  const provider = process.env.IMAGE_GEN_PROVIDER ?? "gemini";
  const apiKey = provider === "gemini"
    ? process.env.GEMINI_API_KEY
    : process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
    console.warn(`[image-gen] ${keyName} not set — image generation disabled`);
    return null;
  }

  console.log(`[image-gen] generating via ${provider}: "${prompt.slice(0, 80)}"`);

  try {
    if (provider === "gemini") {
      return await generateGemini(prompt, apiKey);
    }
    if (provider === "openai") {
      return await generateOpenAI(prompt, apiKey);
    }
    console.warn(`[image-gen] unknown IMAGE_GEN_PROVIDER: "${provider}" — supported: "gemini", "openai"`);
    return null;
  } catch (err) {
    console.error("[image-gen] generation failed:", err);
    return null;
  }
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[];
    };
  }[];
}

async function generateGemini(prompt: string, apiKey: string): Promise<string | null> {
  const model = "gemini-3-pro-image-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini image API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GeminiResponse;
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("No parts in Gemini response");

  for (const part of parts) {
    if (part.inlineData?.data) {
      const buffer = Buffer.from(part.inlineData.data, "base64");
      const ext = part.inlineData.mimeType?.includes("png") ? "png" : "jpg";
      const outPath = join(tmpdir(), `egg-img-${Date.now()}.${ext}`);
      writeFileSync(outPath, buffer);
      console.log(`[image-gen] saved ${buffer.length} bytes → ${outPath}`);
      return outPath;
    }
  }

  throw new Error("No image data in Gemini response");
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

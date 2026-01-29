// src/ingestion/model.ts
import { getGeminiClient } from "../clients/geminiClient.js";
import { withRetry } from "../utils/retry.js";
import { truncate } from "./utils.js";

const PRIMARY_MODEL = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-1.5-flash";

// Keep worker replies bounded (WhatsApp can handle longer, but keep it sane)
const MAX_REPLY_CHARS = parseInt(process.env.MAX_REPLY_CHARS ?? "1200", 10);

export async function callModel(opts: {
    userText: string;
    conversationId: string;
    inboundProviderSid: string;
    timeoutMs: number;
    fromAddress?: string;
}): Promise<string> {
    const userText = String(opts.userText ?? "").trim();
    if (!userText) return "Send me a message and I’ll reply.";

    const ai = getGeminiClient();

    const prompt = [
        "Respond as if you are the Toronto icon Drake sending an SMS reply.",
        "Keep messages short, direct, and build a connection with the user.",
        opts.fromAddress ? `User (${opts.fromAddress}): ${userText}` : `User: ${userText}`,
    ].join("\n");

    const callGemini = (model: string) =>
        ai.models.generateContent({
            model,
            contents: prompt,
            // If your Gemini client supports AbortSignal, pass it here.
            // signal,
        });

    // Local timeout guard. Even if the SDK doesn't support AbortSignal,
    // Promise.race will return control to the worker so it can retry/backoff.
    const withTimeout = async <T>(p: Promise<T>): Promise<T> => {
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Model timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs)
        );
        return Promise.race([p, timeout]);
    };

    try {
        const response = await withRetry(
            () => withTimeout(callGemini(PRIMARY_MODEL)),
            { retries: 4, baseDelayMs: 350, maxDelayMs: 3500 }
        );

        const reply = response?.text?.trim();
        if (!reply) return "I didn’t catch that — try again?";

        return reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + "…" : reply;
    } catch (err: any) {
        const status = err?.status ?? err?.error?.code;

        // Overloaded / rate limited: try fallback model once (also with retry)
        if (status === 503 || status === 429) {
            const response = await withRetry(
                () => withTimeout(callGemini(FALLBACK_MODEL)),
                { retries: 2, baseDelayMs: 400, maxDelayMs: 2500 }
            );

            const reply = response?.text?.trim();
            if (!reply) return "I didn’t catch that — try again?";

            return reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + "…" : reply;
        }

        console.error(
            `[model] Gemini error convo=${opts.conversationId} inbound=${opts.inboundProviderSid}:`,
            truncate(err?.stack || err?.message || String(err), 1500)
        );
        return "I’m a bit jammed up right now — try again in a minute.";
    }
}

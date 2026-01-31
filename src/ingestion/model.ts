// src/ingestion/model.ts
import { getOpenAIClient } from "../clients/openaiClient.js";
import { withRetry } from "../utils/retry.js";
import { truncate } from "./utils.js";

const PRIMARY_MODEL = process.env.OPENAI_MODEL ?? "gpt-5";
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL ?? "gpt-5-mini";

// Keep worker replies bounded (WhatsApp can handle longer, but keep it sane)
const MAX_REPLY_CHARS = parseInt(process.env.MAX_REPLY_CHARS ?? "1200", 10);

export async function callModel(opts: {
    conversationId: string;
    inboundProviderSid: string;
    timeoutMs: number;
    fromAddress?: string;
    conversationContext?: string;
}): Promise<string> {
    const context = String(opts.conversationContext ?? "").trim();
    if (!context) return "Send me a message and I’ll reply.";

    const client = getOpenAIClient();

    const instructions = [
        "Respond as if you are the Toronto icon Drake sending an SMS reply.",
        "Keep messages short, direct, and build a connection with the user.",
    ].join("\n");

    const input = [
        context ? `Conversation so far:\n${context}` : "",
        "",
        "Reply as the assistant to the most recent USER message above.",
    ].join("\n");

    const callOpenAI = (model: string, signal?: AbortSignal) =>
        client.responses.create({
            model,
            instructions,
            input,
            // Optional knobs:
            // max_output_tokens: 300,
            // temperature: 0.8,
        }, { signal });

    // Timeout guard (and actually abort the request if supported)
    const withTimeout = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), opts.timeoutMs);

        try {
            return await fn(controller.signal);
        } finally {
            clearTimeout(t);
        }
    };

    try {
        const response = await withRetry(
            () => withTimeout((signal) => callOpenAI(PRIMARY_MODEL, signal)),
            { retries: 4, baseDelayMs: 350, maxDelayMs: 3500 }
        );

        const reply = response?.output_text?.trim();
        if (!reply) return "I didn’t catch that — try again?";

        return reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + "…" : reply;
    } catch (err: any) {
        const status = err?.status ?? err?.response?.status;

        // Overloaded / rate limited: try fallback model once (also with retry)
        if (status === 503 || status === 429) {
            const response = await withRetry(
                () => withTimeout((signal) => callOpenAI(FALLBACK_MODEL, signal)),
                { retries: 2, baseDelayMs: 400, maxDelayMs: 2500 }
            );

            const reply = response?.output_text?.trim();
            if (!reply) return "I didn’t catch that — try again?";

            return reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + "…" : reply;
        }

        console.error(
            `[model] OpenAI error convo=${opts.conversationId} inbound=${opts.inboundProviderSid}:`,
            truncate(err?.stack || err?.message || String(err), 1500)
        );

        return "I’m a bit jammed up right now — try again in a minute.";
    }
}

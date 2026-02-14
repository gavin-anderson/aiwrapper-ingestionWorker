// src/inference/model.ts
import { getOpenAIClient } from "../clients/openaiClient.js";
import { withRetry } from "../utils/retry.js";
import { truncate } from "./utils.js";
import { buildSlashPrompt } from "../prompts/index.js";

const PRIMARY_MODEL = process.env.OPENAI_MODEL ?? "gpt-5";
const FALLBACK_MODEL = "gpt-5-mini";

const MAX_REPLY_CHARS = 1200;

export type ModelResult = {
    reply: string;
    model: string;
};

export async function callModel(opts: {
    conversationId: string;
    inboundProviderSid: string;
    timeoutMs: number;
    fromAddress?: string;
    conversationContext?: string;
}): Promise<ModelResult> {
    const context = String(opts.conversationContext ?? "").trim();
    if (!context) return { reply: "Send me a message and I'll reply.", model: "none" };

    const client = getOpenAIClient();

    const { instructions, input } = await buildSlashPrompt({ conversationContext: context });

    const callOpenAI = (model: string, signal?: AbortSignal) =>
        client.responses.create(
            {
                model,
                instructions,
                input,
                // max_output_tokens: 140, // optional for 2-sentence replies
            },
            { signal }
        );

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

        let reply = response?.output_text?.trim();
        if (!reply) return { reply: "I didn't catch that — try again?", model: PRIMARY_MODEL };

        reply = reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + "…" : reply;
        return { reply, model: PRIMARY_MODEL };
    } catch (err: any) {
        const status = err?.status ?? err?.response?.status;

        if (status === 503 || status === 429) {
            const response = await withRetry(
                () => withTimeout((signal) => callOpenAI(FALLBACK_MODEL, signal)),
                { retries: 2, baseDelayMs: 400, maxDelayMs: 2500 }
            );

            let reply = response?.output_text?.trim();
            if (!reply) return { reply: "I didn't catch that — try again?", model: FALLBACK_MODEL };

            reply = reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + "…" : reply;
            return { reply, model: FALLBACK_MODEL };
        }

        console.error(
            `[model] OpenAI error convo=${opts.conversationId} inbound=${opts.inboundProviderSid}:`,
            truncate(err?.stack || err?.message || String(err), 1500)
        );

        return { reply: "I'm a bit jammed up right now — try again in a minute.", model: "error" };
    }
}

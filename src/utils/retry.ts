export type RetryOptions = {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
};

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

function isRetryableGeminiError(err: unknown): boolean {
    const e = err as any;
    const status = e?.status ?? e?.error?.code ?? e?.response?.status;
    return status === 429 || status === 503 || status === 500 || status === 504;
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {}
): Promise<T> {
    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 300;
    const maxDelayMs = opts.maxDelayMs ?? 3000;

    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;

            if (!isRetryableGeminiError(err) || attempt === retries) {
                throw err;
            }

            // exponential backoff + jitter
            const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
            const jitter = Math.floor(Math.random() * 150);
            await sleep(exp + jitter);
        }
    }

    throw lastErr;
}

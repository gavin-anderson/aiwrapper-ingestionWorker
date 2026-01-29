// src/ingestion/utils.ts
export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(s: string, max = 1500): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + `…[truncated ${s.length - max} chars]`;
}

/**
 * delaySeconds = min(300, 5 * 3^attempts)
 * attemptsAfterIncrement: 1 => 15s, 2 => 45s, 3 => 135s ...
 */
export function computeReplyBackoffSeconds(attemptsAfterIncrement: number): number {
    const delay = 5 * Math.pow(3, attemptsAfterIncrement);
    return Math.min(300, Math.floor(delay));
}

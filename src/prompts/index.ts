// src/prompts/index.ts

export type BuildPromptOpts = {
    conversationContext: string;
};

export type PromptModule = {
    buildSlashPrompt: (opts: BuildPromptOpts) => { instructions: string; input: string };
    NO_REPLY_SENTINEL: string;
};

const PROMPT_VERSION = process.env.PROMPT_VERSION ?? "V1";

let cachedModule: PromptModule | null = null;

async function loadPromptModule(): Promise<PromptModule> {
    if (cachedModule) return cachedModule;

    try {
        cachedModule = await import(`./${PROMPT_VERSION}/prompt.js`);
        return cachedModule!;
    } catch (err) {
        throw new Error(`Failed to load prompt version "${PROMPT_VERSION}": ${err}`);
    }
}

export async function buildSlashPrompt(opts: BuildPromptOpts): Promise<{ instructions: string; input: string }> {
    const mod = await loadPromptModule();
    return mod.buildSlashPrompt(opts);
}

export async function getNoReplySentinel(): Promise<string> {
    const mod = await loadPromptModule();
    return mod.NO_REPLY_SENTINEL;
}

export function getPromptVersion(): string {
    return PROMPT_VERSION;
}

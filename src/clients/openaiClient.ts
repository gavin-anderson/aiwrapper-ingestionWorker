// src/clients/openaiClient.ts
import OpenAI from "openai";

let clientSingleton: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
    if (clientSingleton) return clientSingleton;

    clientSingleton = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY, // set this in env
    });

    return clientSingleton;
}

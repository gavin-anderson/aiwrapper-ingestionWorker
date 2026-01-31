import { GoogleGenAI } from "@google/genai";

let clientSingleton: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
    if (clientSingleton) return clientSingleton;

    clientSingleton = new GoogleGenAI({});

    return clientSingleton;
}
import { GoogleGenAI } from "@google/genai";

let clientSingleton: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
    if (clientSingleton) return clientSingleton;

    // API key is automatically read from GEMINI_API_KEY
    clientSingleton = new GoogleGenAI({});

    return clientSingleton;
}
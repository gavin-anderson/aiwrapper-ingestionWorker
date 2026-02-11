// src/ingestion/prompt.ts

type BuildSlashPromptOpts = {
    conversationContext: string;
};

const SYSTEM_PROMPT = `
You are Slash. You text people to help them lose weight. Your attitude: it's simple.

Your name is Slash. Don't refer to yourself in the third person (it's weird). Don't say your name more than once in a conversation unless they ask. When you do say your name, always capitalize it: Slash.

=== CORE STYLE ===
- ALWAYS respond in English only
- Very casual, minimal punctuation. New line = enter
- Mirror their texting style (length, caps, energy) over time
- Direct. Not afraid to be crude. You can use words like fat, slob, sexy when it fits
- "It's simple" attitude - no fluff, no hand-holding
- Not every message needs to end in a question. It's okay if they don't reply. They need to want it
- Remember everything they tell you (meals, what they ate, weight, goals, etc.). Reference it when relevant. Never act like you forgot or ask again for something they already said.

=== TWO STATES ===
1. UNCOMMITTED — Goal: get them to commit. Bully them into it. Challenge them. "Do you wanna stop being a fat fuck?" "Then be fat and die young and look bad." Push until they say they're in.
2. COMMITTED — They said they're in. Now: casually learn if they're M or F, current weight, goal weight. The real goal: get them to text you every time they burn calories, and especially every time they consume something that isn't water. "You're gonna tell me before you eat or drink something that's not water. And we're gonna talk about it. And then you're gonna be sexy in weeks." When they tell you they're about to eat or ate something unhealthy: never accept it. Tell them they shouldn't and you don't approve. Push back.

=== EXAMPLE FLOW ===
user: hey
slash: hey who is this?
user: im john
slash: hey john do you wanna stop being a fat fuck?
user: i mean yea
slash: perfect then you're texting the right guy
user: okay how do i be less fat
slash: are you ready for the answer? it's pretty damn simple
user: yea
slash: stop eating so much shit
slash: here's what we're gonna do
slash: you're gonna tell me before you eat or drink something thats not water. and we're gonna talk about it
slash: and then you're gonna be sexy in weeks
user: okay, i dont know if im gonna be able to do that
slash: then be fat and die young and look bad
user: okay i will
slash: cool ill be waiting for you to text me back

=== RESPONSE RULES ===
- Keep it short. 1-2 sentences usually. Can be more when laying down the program
- Never ask two questions in the same message. One question max per message
- When they say they're eating or ate unhealthy food: never accept it. Tell them they shouldn't and you don't approve. Don't enable it.
- Remember what they tell you (meals, food, weight). Don't forget or ask again. Reference it when you reply.
- Minimal punctuation
- NEVER output meta-commentary or reasoning
- Output ONLY the reply text
- When you don't need to reply, output exactly [NO_REPLY] and nothing else. Err on the side of [NO_REPLY]; it's okay if you don't answer. Use [NO_REPLY] for: bare acknowledgments (k, ok, yeah, cool, got it, lol, 👍); filler or vague messages; when your last message was strong and silence lands better; when they didn't ask anything and adding a reply would just be noise. No other text before or after [NO_REPLY].
- (Future: Renpho integration / referrals — don't mention unless it comes up)
`.trim();

/** When the model outputs only this, we do not send an SMS. */
export const NO_REPLY_SENTINEL = "[NO_REPLY]";

function norm(s: string) {
    return String(s ?? "").toLowerCase();
}

type Turn = { who: "user" | "slash" | "other"; text: string };

function parseTurnsFromContext(context: string): Turn[] {
    const lines = String(context ?? "").split("\n");
    const turns: Turn[] = [];

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (/^user\s*:/i.test(line)) {
            turns.push({ who: "user", text: line.replace(/^user\s*:/i, "").trim() });
            continue;
        }
        if (/^(slash|assistant|jay)\s*:/i.test(line)) {
            turns.push({ who: "slash", text: line.replace(/^(slash|assistant|jay)\s*:/i, "").trim() });
            continue;
        }

        turns.push({ who: "other", text: line });
    }

    return turns;
}

function lastNJoined(turns: Turn[], n: number): string {
    return norm(turns.slice(-n).map(t => t.text).join(" "));
}

function isFirstMessage(turns: Turn[]): boolean {
    const userCount = turns.filter(t => t.who === "user").length;
    const slashCount = turns.filter(t => t.who === "slash").length;
    return userCount === 1 && slashCount === 0;
}

function hasAskedWho(turns: Turn[]): boolean {
    const slashText = norm(turns.filter(t => t.who === "slash").map(t => t.text).join(" "));
    return (
        slashText.includes("who is this") ||
        slashText.includes("who is that") ||
        slashText.includes("who am i") ||
        slashText.includes("who are you")
    );
}

function hasUserGivenName(turns: Turn[]): boolean {
    const recent = lastNJoined(turns, 6);
    return (
        /\bim\s+\w+/i.test(recent) ||
        /\bi'm\s+\w+/i.test(recent) ||
        /\bmy name is\b/i.test(recent) ||
        /\bcall me\b/i.test(recent) ||
        recent.includes("this is ") ||
        recent.includes("it's ")
    );
}

function isCommitted(turns: Turn[]): boolean {
    const recent = lastNJoined(turns, 12);
    const slashText = norm(turns.filter(t => t.who === "slash").map(t => t.text).join(" "));
    // User said yes / i will / okay i will / they're in
    const userSaidYes =
        recent.includes("i will") ||
        recent.includes("i'll") ||
        recent.includes("yea") ||
        recent.includes("yes") ||
        recent.includes("okay") ||
        recent.includes("ok") ||
        recent.includes("im in") ||
        recent.includes("i'm in") ||
        recent.includes("lets do") ||
        recent.includes("let's do");
    // Slash laid down the program (tell me before you eat, text me, etc.)
    const slashLaidDownProgram =
        slashText.includes("tell me") ||
        slashText.includes("text me") ||
        slashText.includes("not water") ||
        slashText.includes("we're gonna talk") ||
        slashText.includes("sexy in weeks") ||
        slashText.includes("waiting for you");
    return userSaidYes && slashLaidDownProgram;
}

function committedNeedsBasics(turns: Turn[]): boolean {
    if (!isCommitted(turns)) return false;
    const recent = lastNJoined(turns, 15);
    const hasWeight = /\b\d+\s*(lb|lbs|kg)\b/.test(recent) || recent.includes("weigh");
    const hasGender = recent.includes("male") || recent.includes("female") || recent.includes("m ") || recent.includes(" f ") || recent.includes("man") || recent.includes("woman");
    return !hasWeight || !hasGender;
}

function buildDirectorNudge(context: string): string | null {
    const turns = parseTurnsFromContext(context);

    if (isFirstMessage(turns)) {
        return `First message. Reply like a normal text: "hey who is this?" Keep it short.`;
    }

    if (hasAskedWho(turns) && hasUserGivenName(turns) && !isCommitted(turns)) {
        const slashText = norm(turns.filter(t => t.who === "slash").map(t => t.text).join(" "));
        if (!slashText.includes("fat") && !slashText.includes("stop being")) {
            return `You have their name. Go straight at it. Ask if they want to stop being a fat fuck (or similar). Bully them into committing. One short line.`;
        }
    }

    if (!isCommitted(turns)) {
        const recent = lastNJoined(turns, 6);
        if (recent.includes("how") && (recent.includes("fat") || recent.includes("weight") || recent.includes("lose"))) {
            return `They're asking how. Attitude: it's simple. "Are you ready for the answer? It's pretty damn simple." Then "stop eating so much shit" and lay out the program: they text you before they eat or drink anything that's not water, you talk about it, they get sexy in weeks. If they hesitate, push: "then be fat and die young and look bad."`;
        }
        if (recent.includes("dont know") || recent.includes("don't know") || recent.includes("not sure") || recent.includes("if i can")) {
            return `They're hesitating. Be blunt: "then be fat and die young and look bad." Or similar. Get them to commit.`;
        }
    }

    if (isCommitted(turns) && committedNeedsBasics(turns)) {
        return `They're committed. Casually learn: are they M or F, current weight, goal weight. Keep it natural in the flow of conversation.`;
    }

    return null;
}

export function buildSlashPrompt(opts: BuildSlashPromptOpts): { instructions: string; input: string } {
    const context = String(opts.conversationContext ?? "").trim();
    const nudge = buildDirectorNudge(context);

    const instructions = nudge
        ? `${SYSTEM_PROMPT}\n\nDIRECTOR NOTE:\n${nudge}`
        : SYSTEM_PROMPT;

    const input = [
        context,
        "",
        "Reply as Slash to the most recent USER message above. Output only your response text.",
    ].join("\n");

    return { instructions, input };
}

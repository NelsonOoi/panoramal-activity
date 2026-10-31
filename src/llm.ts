// The one place that talks to the LLM provider (OpenAI). Owner: lead.
// Every call is cached on disk by request hash, so a recorded run replays offline.
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"

export type Tier = "fast" | "smart" // fast: vision per frame + witness testimony; smart: investigator

const MODELS: Record<Tier, string> = {
    fast: process.env.OPENAI_FAST_MODEL ?? "gpt-5.4-mini",
    smart: process.env.OPENAI_SMART_MODEL ?? "gpt-5.5"
}
const EFFORT: Record<Tier, string | undefined> = {
    fast: process.env.OPENAI_FAST_EFFORT ?? "none",
    smart: process.env.OPENAI_SMART_EFFORT ?? "low"
}
const CACHE_DIR = ".cache/llm"

export interface JsonCall {
    tier: Tier
    system: string
    prompt: string
    image?: Uint8Array // JPEG
    maxTokens?: number
}

let warned = false

// Returns the model's reply parsed as JSON, or null when the provider is unavailable.
// The prompt must ask for JSON explicitly (json_object mode requires the word "JSON").
export async function llmJson<T>(call: JsonCall): Promise<T | null> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        if (!warned) console.error("[llm] OPENAI_API_KEY is not set; LLM calls return null")
        warned = true
        return null
    }

    const content: unknown[] = [{ type: "text", text: call.prompt }]
    if (call.image) {
        const url = `data:image/jpeg;base64,${Buffer.from(call.image).toString("base64")}`
        content.push({ type: "image_url", image_url: { url, detail: "low" } })
    }
    const body: Record<string, unknown> = {
        model: MODELS[call.tier],
        messages: [
            { role: "system", content: call.system },
            { role: "user", content }
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: call.maxTokens ?? 2000
    }
    if (EFFORT[call.tier]) body.reasoning_effort = EFFORT[call.tier]

    const key = createHash("sha256").update(JSON.stringify(body)).digest("hex")
    const cached = await readFile(`${CACHE_DIR}/${key}.json`, "utf8").catch(() => null)
    if (cached) return JSON.parse(cached) as T

    const started = Date.now()
    let res = await post(apiKey, body)
    if (res.status === 400 && body.reasoning_effort && (await res.clone().text()).includes("reasoning_effort")) {
        delete body.reasoning_effort // model doesn't take this effort value; retry without it
        res = await post(apiKey, body)
    }
    if (!res.ok) {
        console.error(`[llm] ${MODELS[call.tier]} ${res.status}: ${(await res.text()).slice(0, 300)}`)
        return null
    }
    const data = (await res.json()) as { choices: { message: { content: string | null } }[] }
    const text = data.choices[0]?.message.content ?? ""
    console.log(`[llm] ${MODELS[call.tier]} ${Date.now() - started}ms`)
    try {
        const parsed = JSON.parse(text) as T
        await mkdir(CACHE_DIR, { recursive: true })
        await writeFile(`${CACHE_DIR}/${key}.json`, JSON.stringify(parsed))
        return parsed
    } catch {
        console.error(`[llm] reply was not JSON: ${text.slice(0, 200)}`)
        return null
    }
}

function post(apiKey: string, body: Record<string, unknown>) {
    return fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
    })
}

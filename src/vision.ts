// Vision per frame (LLM "fast" tier via src/llm.ts): people (with bbox), objects, notable event.
// llm.ts caches on disk and handles a missing key; this file builds the prompt and validates the reply.
import { llmJson } from "./llm.js"
import type { VisionResult } from "./shared/types.js"

const EMPTY: VisionResult = { people: [], objects: [], notable: null }

const SYSTEM = "You are a security camera's vision module. You describe exactly what is visible in one frame and reply with JSON only."

const SHAPE = `{
  "people": [{ "id": string, "desc": string, "x": number, "y": number, "w": number, "h": number, "action": string }],
  "objects": [{ "label": string, "x": number, "y": number, "heldBy"?: string }],
  "notable": string | null
}`

export function buildPrompt(camId: string, known: { id: string; desc: string }[], labels: string[] = []): string {
    const knownStr = known.length ? known.map(k => `${k.id}: "${k.desc}"`).join(", ") : "none yet"
    return [
        `You are camera ${camId}. People seen recently (most recent first): {${knownStr}}.`,
        `For this frame, reply with a JSON object of exactly this shape:\n${SHAPE}`,
        `Reuse a known id if the person matches (same clothes/appearance); otherwise use "new".`,
        `Each person: id, desc (short appearance: clothing colours, bag, hat), x, y, w, h (bounding box, 0–1 of the frame, x/y = top-left), action (a few words).`,
        `Each object worth noting (bags, phones, boxes, laptops): label, x, y (centre, 0–1), heldBy (person id) if someone holds it.`,
        ...(labels.length ? [`Objects this camera has been tracking: ${labels.join(", ")}. Reuse exactly these labels for the same objects.`] : []),
        `Set "notable" to a short phrase only for meaningful events (picks up or puts down an object, falls, runs, enters a restricted area), else null.`,
        `Report at most 6 people: the most prominent ones, nearest and largest first. Ignore distant background people unless they interact with an object.`,
        `Only include people who are actually visible. An empty frame has people: [].`
    ].join("\n")
}

const clamp = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0))

function sanitize(r: any): VisionResult {
    return {
        people: Array.isArray(r?.people)
            ? r.people.filter((p: any) => p && typeof p === "object").map((p: any) => ({
                  id: String(p.id ?? "new"),
                  desc: String(p.desc ?? ""),
                  x: clamp(p.x), y: clamp(p.y), w: clamp(p.w), h: clamp(p.h),
                  action: String(p.action ?? "")
              })).slice(0, 6)
            : [],
        objects: Array.isArray(r?.objects)
            ? r.objects.filter((o: any) => o && typeof o === "object").map((o: any) => ({ label: String(o.label ?? ""), x: clamp(o.x), y: clamp(o.y), ...(o.heldBy ? { heldBy: String(o.heldBy) } : {}) }))
            : [],
        notable: typeof r?.notable === "string" && r.notable.trim() ? r.notable.trim() : null
    }
}

export async function describeFrame(camId: string, jpeg: Buffer, known: { id: string; desc: string }[], labels: string[] = []): Promise<VisionResult> {
    try {
        const reply = await llmJson<unknown>({ tier: "fast", system: SYSTEM, prompt: buildPrompt(camId, known, labels), image: jpeg, maxTokens: 1500 })
        if (!reply) return EMPTY
        const r = sanitize(reply)
        console.log(`[vision] ${camId}: ${r.people.length} people${r.notable ? `, notable "${r.notable}"` : ""}`)
        return r
    } catch (err) {
        console.error(`[vision] ${camId}: call failed:`, err instanceof Error ? err.message : err)
        return EMPTY
    }
}

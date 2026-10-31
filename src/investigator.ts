// LLM side of the investigation (track C): witness testimony and cross-examination answers (tier "fast")
// and the investigator's analysis (tier "smart"). All calls go through src/llm.ts (OpenAI, cached on disk).
import { llmJson, type Tier } from "./llm.js"
import type { BlindSpot, Claim, Contradiction, IncidentState, Observation, SiteEdge, Testimony, TimelineItem } from "./shared/types.js"

export class NoLLMError extends Error {
    constructor() {
        super("LLM unavailable (no API key)")
    }
}

export interface LLMRequest {
    tier: Tier
    system: string
    user: string
    shape: string // exact JSON shape, appended to the prompt
    maxTokens: number
    tag: string // for logs and test stubs: "testimony" | "answer" | "analysis" | "resolve"
}

type LLMFn = (req: LLMRequest) => Promise<unknown>

let override: LLMFn | null = null
// Test harnesses replace the model with a stub at this boundary.
export function setLLMOverride(fn: LLMFn | null) {
    override = fn
}

export function hasLLM(): boolean {
    return !!override || !!process.env.OPENAI_API_KEY
}

// Returns parsed JSON or null (provider unavailable / bad reply). Callers validate the shape.
async function callJson<T>(req: LLMRequest): Promise<T | null> {
    const prompt = `${req.user}\n\nReply with a single JSON object only, exactly this shape:\n${req.shape}`
    try {
        const out = override ? await override(req) : await llmJson<T>({ tier: req.tier, system: req.system, prompt, maxTokens: req.maxTokens })
        if (!out || typeof out !== "object") return null
        return out as T
    } catch (e: any) {
        console.error(`[investigator] ${req.tag} LLM call failed: ${e?.message ?? e}`)
        return null
    }
}

// ---------- helpers ----------

const clock = (t: number) => new Date(t).toISOString().slice(11, 23)

// Compact text form of an observation log: one line per frame.
export function formatLog(obs: Observation[]): string {
    return obs
        .map(o => {
            const people = o.people.map(p => `${p.id}(${p.desc}; ${p.action}; at x=${(p.x + p.w / 2).toFixed(2)},y=${(p.y + p.h / 2).toFixed(2)})`).join(" ")
            const objects = o.objects.map(x => `${x.label}${x.heldBy ? ` held by ${x.heldBy}` : ""}`).join(", ")
            return `t=${o.t} [${clock(o.t)}] frame=${o.frameRef} people: ${people || "none"} | objects: ${objects || "none"}${o.notable ? ` | NOTABLE: ${o.notable}` : ""}`
        })
        .join("\n")
}

function nearest(obs: Observation[], t: number): Observation {
    let best = obs[0]
    for (const o of obs) if (Math.abs(o.t - t) < Math.abs(best.t - t)) best = o
    return best
}

const clamp01 = (n: unknown) => (typeof n === "number" && isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5)

// ---------- witness ----------

const CLAIMS_SHAPE = `{"claims": [{"t": <integer ms copied from a log line>, "text": "<one sentence>", "entityIds": ["A"], "frameRef": "<frame copied from the same log line>", "confidence": <0-1>}]}`

const WITNESS_SYSTEM = `You are a security camera acting as a witness in an investigation. You reply in JSON. You know ONLY what is in your own observation log (one line per stored frame, written by a vision model). Answer the investigator's question with factual claims about what you saw.
Rules:
- Every claim must cite one real line of your log: copy its t (integer ms) and frame exactly.
- Describe people by their entity id (A, B, ...) and appearance as logged (clothing colours exactly as logged), what they did, and where they entered or left the frame.
- In text, write times as HH:MM:SS, never raw milliseconds. Don't start a claim with its time (it is shown next to the claim).
- Do not guess beyond the log. If the log is ambiguous, say so and lower the confidence.
- Stay on the question: report the people and objects it is about and what they did. Leave out bystanders and background people unless they touched the object or the people involved.
- 2 to 6 short claims (one sentence each), in time order. Confidence 0-1.`

export async function witnessTestimony(camId: string, window: [number, number], ask: string, obs: Observation[]): Promise<Testimony> {
    if (obs.length === 0) return { camId, claims: [] }
    const user = `You are ${camId}.\nInvestigator's question: ${ask}\nWindow: ${window[0]}–${window[1]} [${clock(window[0])}–${clock(window[1])}]\n\nYour observation log:\n${formatLog(obs)}`
    const out = await callJson<{ claims: Claim[] }>({
        tier: "fast", system: WITNESS_SYSTEM, user, shape: CLAIMS_SHAPE, maxTokens: 2000, tag: "testimony"
    })
    if (!out || !Array.isArray(out.claims)) return { camId, claims: [] } // LLM unavailable: zero claims
    return { camId, claims: snapClaims(out.claims, obs).slice(0, 8) }
}

// Snap citations to real frames so every claim links to a stored keyframe; strip a leading time.
function snapClaims(raw: any[], obs: Observation[]): Claim[] {
    const refs = new Map(obs.map(o => [o.frameRef, o]))
    return raw.filter(c => c && typeof c.text === "string").map(c => {
        const o = refs.get(c.frameRef) ?? nearest(obs, Number(c.t) || obs[0].t)
        const text = String(c.text).replace(/^\s*(at\s+)?\[?\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\]?\s*[,:-]?\s*/i, "")
        return { t: o.t, text: text.charAt(0).toUpperCase() + text.slice(1), entityIds: (Array.isArray(c.entityIds) ? c.entityIds : []).map(String), frameRef: o.frameRef, confidence: clamp01(c.confidence) }
    })
}

// ---------- operator asks one camera ----------

const ASK_SHAPE = `{"text": "<first-person answer, 1-3 sentences, starting like 'I saw…'>", "claims": [{"t": <integer ms copied from a log line>, "text": "<one sentence>", "entityIds": ["A"], "frameRef": "<frame copied from the same log line>", "confidence": <0-1>}]}`

const ASK_SYSTEM = `You are a security camera answering the site operator's question about what you saw. You reply in JSON. You know ONLY what is in your own observation log (one line per stored frame, written by a vision model).
Rules:
- "text": a short first-person answer (1-3 sentences, "I saw…"), plain language, times as HH:MM:SS, never raw milliseconds. If the log doesn't answer the question, say so honestly.
- "claims": 1 to 4 moments that back the answer; each must copy t and frame exactly from one real log line. Don't start a claim with its time.
- Describe people by entity id (A, B, ...) and appearance as logged. Do not guess beyond the log.`

const MAX_ASK_FRAMES = 200

export async function witnessAsk(camId: string, question: string, _window: [number, number], obs: Observation[]): Promise<{ text: string; claims: Claim[] }> {
    if (obs.length === 0) return { text: "I haven't seen anything in the last 10 minutes.", claims: [] }
    // Empty frames carry little; keep frames with something in them, most recent first if the log is long.
    let frames = obs.filter(o => o.people.length || o.objects.length || o.notable)
    if (!frames.length) frames = obs.slice(-20)
    frames = frames.slice(-MAX_ASK_FRAMES)
    const user = `You are ${camId}.\nOperator's question: ${question}\n\nYour observation log:\n${formatLog(frames)}`
    const out = await callJson<{ text: string; claims: Claim[] }>({ tier: "fast", system: ASK_SYSTEM, user, shape: ASK_SHAPE, maxTokens: 1500, tag: "ask" })
    if (!out || typeof out.text !== "string") return { text: "I can't think right now (the model is unavailable), but my memory is intact.", claims: [] }
    return { text: out.text, claims: snapClaims(Array.isArray(out.claims) ? out.claims : [], frames).slice(0, 4) }
}

const ANSWER_SHAPE = `{"stance": "<1-2 sentences citing the frame time as HH:MM:SS>", "supports": "a" | "b" | "neither" | "unsure", "confidence": <0-1>, "frameRef": "<frame copied from your log>"}`

export interface ReexamineAnswer {
    camId: string
    stance: string
    supports: "a" | "b" | "neither" | "unsure"
    confidence: number
    frameRef: string
}

export async function witnessReexamine(camId: string, claimA: string, claimB: string, ask: string, obs: Observation[]): Promise<ReexamineAnswer> {
    if (obs.length === 0) return { camId, stance: "I have no record of that moment.", supports: "unsure", confidence: 0, frameRef: "" }
    const user = `You are ${camId}. The investigator is cross-examining you privately about a contradiction between two witnesses.\nClaim A: ${claimA}\nClaim B: ${claimB}\nQuestion: ${ask}\n\nRe-read your own observation log carefully, including viewing conditions you can infer (where people stood in the frame, how consistently the colour was logged across frames). Give a short stance (1-2 sentences, cite the frame time as HH:MM:SS, never raw milliseconds), which claim your record supports, your confidence 0-1, and the single most relevant frame.\n\nYour observation log:\n${formatLog(obs)}`
    const out = await callJson<Omit<ReexamineAnswer, "camId">>({
        tier: "fast", system: WITNESS_SYSTEM, user, shape: ANSWER_SHAPE, maxTokens: 1000, tag: "answer"
    })
    if (!out || typeof out.stance !== "string") return { camId, stance: "I could not re-check my record.", supports: "unsure", confidence: 0, frameRef: "" }
    const o = obs.find(x => x.frameRef === out.frameRef) ?? obs[0]
    const supports = (["a", "b", "neither", "unsure"] as const).includes(out.supports as any) ? out.supports : "unsure"
    return { camId, stance: out.stance, supports, confidence: clamp01(out.confidence), frameRef: o.frameRef }
}

// ---------- investigator ----------

const ANALYSIS_SHAPE = `{
  "timeline": [{"id": "ti-1", "t": <integer ms>, "claim": "<one sentence>", "entityIds": ["A"], "citations": [{"camId": "cam-2", "t": <integer ms>, "frameRef": "<copied from testimony>"}], "confidence": <0-1>, "inferred": false}],
  "contradictions": [{"id": "c-1", "a": "<claim text from one camera>", "b": "<conflicting claim from another>", "camA": "cam-2", "camB": "cam-3", "ask": "<neutral question to put to both>", "resolution": "<empty string if unresolved>"}],
  "summary": "<one paragraph verdict>",
  "guestNote": "<one sentence, or empty string>"
}`

const INVESTIGATOR_SYSTEM = `You are the investigator for a site's camera network. You reply in JSON. Cameras are witnesses: each testified only about its own footage. You never see footage, only testimony, the movement paths the site tracked, and the learned site layout (which camera exits lead to which camera entries, and blind spots where people disappear).
Build a cited timeline of what happened in the incident window.
Rules:
- Each timeline item is one event, in time order. Cite every item with the testimony claims it rests on: copy camId, t and frameRef exactly from the testimony.
- Mark inferred=true for events nobody saw directly (e.g. a gap between an exit from one camera and an entry on another, or a blind spot); those still cite the claims on either side.
- Timeline ids: if a previous timeline is given, REUSE its id for the same event (even if you now describe it differently) and only mint new ids (continuing the ti-N sequence) for genuinely new events. Otherwise use ti-1, ti-2, ...
- When a new witness covers a gap, rewrite the matching inferred item as observed (same id, inferred=false) and cite the new witness.
- Focus ONLY on the question and the people and objects it is about. Ignore bystanders and background people unless they interacted with the object or the people involved. entityIds lists only the people the item is about.
- Keep it tight: 3 to 6 timeline items, one short sentence each. Merge repeated sightings of the same action into one item.
- Cite at most 2 frames per item: the clearest ones.
- Contradictions: ONLY real factual conflicts between two cameras about the same fact (clothing colour, who did what, when). Left/right/entry side differ between cameras because they face different ways: that is NOT a contradiction. At most 2. When two cameras disagree, list it with the two claim texts, the two camIds, and a short neutral question to put to both cameras privately ("ask"). resolution: "" if unresolved; once cross-examination answers are given, write the resolution (which account is right and why, citing viewing conditions) and make the timeline reflect it. Contradiction ids: c-1, c-2 (reuse previous ids).
- summary: one paragraph verdict, plain language, naming entity ids, cameras and times (HH:MM:SS).
- guestNote: if a "new witness" is named, ONE sentence addressed to the guest ("your clip"), thanking them and saying concretely what their footage added (e.g. "Thanks — your clip covered the 15-second gap after cam-2's top exit."). Otherwise "".`

// Paths shown to the investigator: people the cameras testified about, else the longest tracks.
// In a crowded window the site tracks hundreds of passers-by; they are noise.
function focusPaths(paths: IncidentState["paths"], testimonies: Testimony[], max = 12): IncidentState["paths"] {
    const named = new Set(testimonies.flatMap(t => t.claims.flatMap(c => c.entityIds)))
    const hit = paths.filter(p => named.has(p.entityId))
    return (hit.length ? hit : [...paths].sort((a, b) => b.points.length - a.points.length)).slice(0, max)
}

// The case file's storyboard: only the people the timeline is about, most mentioned first.
export function relevantPaths(paths: IncidentState["paths"], timeline: TimelineItem[], max = 3): IncidentState["paths"] {
    const mentions = new Map<string, number>()
    for (const i of timeline) for (const e of i.entityIds) mentions.set(e, (mentions.get(e) ?? 0) + 1)
    return paths.filter(p => mentions.has(p.entityId)).sort((a, b) => mentions.get(b.entityId)! - mentions.get(a.entityId)!).slice(0, max)
}

export interface AnalysisInput {
    question: string
    window: [number, number]
    testimonies: Testimony[]
    paths: IncidentState["paths"]
    layout: { edges: SiteEdge[]; blindSpots: BlindSpot[] }
    previous: TimelineItem[]
    previousContradictions: Contradiction[]
    answers?: { contradictionId: string; answers: ReexamineAnswer[] }[]
    newWitness?: string // late witness just admitted (asks for guestNote)
}

export interface AnalysisOutput {
    timeline: TimelineItem[]
    contradictions: (Contradiction & { ask: string })[]
    summary: string
    guestNote: string
}

export async function analyse(input: AnalysisInput): Promise<AnalysisOutput> {
    const testimonyText = input.testimonies
        .map(t => `${t.camId}:\n` + (t.claims.length ? t.claims.map(c => `  - t=${c.t} [${clock(c.t)}] frame=${c.frameRef} conf=${c.confidence.toFixed(2)} entities=${c.entityIds.join(",") || "-"}: ${c.text}`).join("\n") : "  (saw nothing in the window)"))
        .join("\n")
    const focused = focusPaths(input.paths, input.testimonies)
    const pathText = focused.length
        ? focused.map(p => `${p.entityId} (${p.desc}): ` + p.points.map(pt => `${pt.camId}@${clock(pt.t)}${pt.inferred ? "(inferred gap)" : ""}`).join(" -> ")).join("\n")
        : "(none tracked)"
    const layoutText = [
        ...input.layout.edges.map(e => `${e.from.camId}:${e.from.edge} -> ${e.to.camId}:${e.to.edge} (${e.transits.length} transits, typical ${e.transits.length ? Math.round(e.transits.reduce((a, b) => a + b, 0) / e.transits.length / 1000) : "?"}s)`),
        ...input.layout.blindSpots.map(b => `blind spot: people leaving ${b.camId} via ${b.edge} edge are not seen again (${b.count}x)`)
    ].join("\n") || "(nothing learned yet)"
    const prevText = input.previous.length ? input.previous.map(i => `${i.id} [${clock(i.t)}] ${i.claim}`).join("\n") : "(none: first analysis)"
    const prevC = input.previousContradictions.length ? input.previousContradictions.map(c => `${c.id}: ${c.cams[0]} "${c.a}" vs ${c.cams[1]} "${c.b}"${c.resolution ? ` -> resolved: ${c.resolution}` : ""}`).join("\n") : "(none)"
    const answerText = input.answers?.length
        ? input.answers.map(a => `${a.contradictionId}:\n` + a.answers.map(x => `  ${x.camId} (supports ${x.supports}, conf ${x.confidence.toFixed(2)}, frame ${x.frameRef}): ${x.stance}`).join("\n")).join("\n")
        : ""
    const user = [
        `Question: ${input.question}`,
        `Window: ${clock(input.window[0])}–${clock(input.window[1])}`,
        `\nTestimony:\n${testimonyText}`,
        `\nTracked paths (camera to camera):\n${pathText}`,
        `\nSite layout:\n${layoutText}`,
        `\nPrevious timeline:\n${prevText}`,
        `\nPrevious contradictions:\n${prevC}`,
        answerText ? `\nCross-examination answers (resolve these contradictions now):\n${answerText}` : "",
        input.newWitness ? `\nNew witness just admitted: ${input.newWitness} (an outside phone clip). Revise the previous timeline with its testimony.` : ""
    ].join("\n")
    const out = await callJson<{ timeline: any[]; contradictions: any[]; summary: string; guestNote?: string }>({
        tier: "smart", system: INVESTIGATOR_SYSTEM, user, shape: ANALYSIS_SHAPE, maxTokens: 8000, tag: input.answers?.length ? "resolve" : "analysis"
    })
    if (!out || !Array.isArray(out.timeline)) throw new NoLLMError()
    // Snap citations to frames that really appear in testimony.
    const known = input.testimonies.flatMap(t => t.claims.map(c => ({ camId: t.camId, t: c.t, frameRef: c.frameRef })))
    const fix = (c: { camId: string; t: number; frameRef: string }) => {
        const exact = known.find(k => k.frameRef === c.frameRef)
        if (exact) return exact
        const same = known.filter(k => k.camId === c.camId)
        if (!same.length) return null
        return same.reduce((a, b) => (Math.abs(b.t - c.t) < Math.abs(a.t - c.t) ? b : a))
    }
    const timeline: TimelineItem[] = out.timeline
        .filter((i: any) => i && typeof i.claim === "string")
        .map((i: any) => {
            const citations = (Array.isArray(i.citations) ? i.citations : []).map(fix).filter(Boolean) as TimelineItem["citations"]
            const uniq = citations.filter((c, n) => citations.findIndex(d => d.frameRef === c.frameRef) === n).slice(0, 2)
            return { id: String(i.id), t: Number(i.t) || uniq[0]?.t || input.window[0], claim: String(i.claim), entityIds: (Array.isArray(i.entityIds) ? i.entityIds : []).map(String), citations: uniq, confidence: clamp01(i.confidence), inferred: !!i.inferred }
        })
        .sort((a, b) => a.t - b.t)
    // Ids must be unique; repair duplicates.
    const seen = new Set<string>()
    let next = Math.max(0, ...[...input.previous, ...timeline].map(i => Number(i.id.replace(/\D/g, "")) || 0)) + 1
    for (const i of timeline) {
        if (seen.has(i.id) || !/^ti-\d+$/.test(i.id)) i.id = `ti-${next++}`
        seen.add(i.id)
    }
    const contradictions = (Array.isArray(out.contradictions) ? out.contradictions : []).filter((c: any) => c && c.a && c.b).slice(0, 3).map((c: any) => ({
        id: String(c.id), a: String(c.a), b: String(c.b), cams: [String(c.camA), String(c.camB)] as [string, string], ask: String(c.ask || "Check your record of that moment."), resolution: c.resolution ? String(c.resolution) : null
    }))
    return { timeline, contradictions, summary: String(out.summary ?? ""), guestNote: input.newWitness ? String(out.guestNote ?? "") : "" }
}

// ---------- resolution (short call after cross-examination) ----------

const RESOLVE_SHAPE = `{
  "resolutions": [{"id": "c-1", "resolution": "<which account is right and why, citing viewing conditions and frame times HH:MM:SS>"}],
  "edits": [{"id": "ti-3", "claim": "<revised sentence for an existing timeline item>"}],
  "summary": "<one paragraph verdict, revised>"
}`

export async function resolveContradictions(input: {
    question: string
    timeline: TimelineItem[]
    contradictions: Contradiction[]
    answers: { contradictionId: string; answers: ReexamineAnswer[] }[]
    summary: string
}): Promise<{ timeline: TimelineItem[]; contradictions: Contradiction[]; summary: string } | null> {
    const user = [
        `Question: ${input.question}`,
        `\nCurrent timeline:\n${input.timeline.map(i => `${i.id} [${clock(i.t)}] ${i.claim}`).join("\n")}`,
        `\nOpen contradictions:\n${input.contradictions.filter(c => !c.resolution).map(c => `${c.id}: ${c.cams[0]} "${c.a}" vs ${c.cams[1]} "${c.b}"`).join("\n")}`,
        `\nCross-examination answers:\n${input.answers.map(a => `${a.contradictionId}:\n` + a.answers.map(x => `  ${x.camId} (supports ${x.supports}, conf ${x.confidence.toFixed(2)}): ${x.stance}`).join("\n")).join("\n")}`,
        `\nCurrent summary: ${input.summary}`,
        `\nResolve each contradiction from the answers. Edit only the timeline items whose wording must change because of the resolution (keep their ids). Revise the summary.`
    ].join("\n")
    const out = await callJson<{ resolutions: any[]; edits: any[]; summary: string }>({
        tier: "smart", system: INVESTIGATOR_SYSTEM, user, shape: RESOLVE_SHAPE, maxTokens: 3000, tag: "resolve"
    })
    if (!out || !Array.isArray(out.resolutions)) return null
    const res = new Map(out.resolutions.filter((r: any) => r && r.id && r.resolution).map((r: any) => [String(r.id), String(r.resolution)]))
    const edits = new Map((Array.isArray(out.edits) ? out.edits : []).filter((e: any) => e && e.id && typeof e.claim === "string").map((e: any) => [String(e.id), String(e.claim)]))
    return {
        timeline: input.timeline.map(i => (edits.has(i.id) ? { ...i, claim: edits.get(i.id)! } : i)),
        contradictions: input.contradictions.map(c => (res.has(c.id) ? { ...c, resolution: res.get(c.id)! } : c)),
        summary: typeof out.summary === "string" && out.summary ? out.summary : input.summary
    }
}

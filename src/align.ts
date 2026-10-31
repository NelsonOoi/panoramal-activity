// Guest clip alignment: match what the guest saw with what fixed cameras saw.
import { actors } from "../generated/index.js"
import type { Observation } from "./shared/types.js"

const STOP = new Set(["the", "and", "with", "from", "into", "onto", "their", "his", "her", "person", "someone", "near", "towards", "toward", "standing", "walking", "looking", "yellow", "red", "blue", "black", "white", "green"])

// Synonyms → one token, so "tote" matches "bag" and "left" matches "exits".
const SYN: Record<string, string> = {}
for (const [token, list] of Object.entries({
    bag: "bag tote backpack purse handbag satchel",
    phone: "phone mobile",
    laptop: "laptop computer",
    leave: "leave leaves left exit exits"
})) for (const w of list.split(" ")) SYN[w] = token

// Crude stemmer: picks/picked/picking → pick.
function stem(w: string): string {
    if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3)
    if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2)
    if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2)
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
    return w
}

export function normWords(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(w => w.length >= 3 && !STOP.has(w))
        .map(w => SYN[w] ?? SYN[stem(w)] ?? stem(w))
        .filter(w => w.length >= 3 && !STOP.has(w))
}

// Event words (notable + actions) weigh 1; object labels weigh 0.5 (objects sit in many frames, events in few).
function words(o: Observation): Map<string, number> {
    const m = new Map<string, number>()
    for (const w of normWords(o.objects.map(x => x.label).join(" "))) m.set(w, 0.5)
    for (const w of normWords([o.notable ?? "", ...o.people.map(p => p.action)].join(" "))) m.set(w, 1)
    return m
}

// Score between two observations (shared normalised words + a bonus when both flagged a notable event).
export function matchScore(a: Observation, b: Observation): number {
    const wa = words(a)
    let score = 0
    for (const [w, weight] of words(b)) if (wa.has(w)) score += Math.min(weight, wa.get(w)!)
    if (score > 0 && a.notable && b.notable) score += 0.5
    return score
}

const isEvent = (o: Observation) => !!o.notable || o.people.some(p => p.action && !/^(standing|walking|idle|sitting)$/i.test(p.action.trim()))

export async function alignOffset(guestCamId: string): Promise<{ offsetMs: number; offsetErrMs: number; matched: string | null }> {
    const guest = actors.CameraActor.get(guestCamId)
    const meta = await guest.info()
    const gObs = (await guest.recall(0, Number.MAX_SAFE_INTEGER)).map(o => ({ ...o, t: o.t - (meta?.offsetMs ?? 0) }))
    if (!gObs.length) return { offsetMs: 0, offsetErrMs: 5000, matched: null }
    const g0 = gObs[0].t, g1 = gObs[gObs.length - 1].t

    const cams = (await actors.SiteActor.get("site").listCameras()).filter(c => c.kind === "fixed")
    const fixed: Observation[] = []
    for (const c of cams) fixed.push(...(await actors.CameraActor.get(c.id).recall(g0 - 10 * 60_000, g1 + 10 * 60_000)))
    // Fixed cameras' alerts are events too ("Yellow tote is gone").
    const fixedIds = new Set(cams.map(c => c.id))
    for (const a of (await actors.SiteActor.get("site").snapshot()).alerts)
        if (fixedIds.has(a.camId)) fixed.push({ camId: a.camId, t: a.t, frameRef: a.frameRef, people: [], objects: [], notable: a.text })

    let best: { score: number; dt: number; offset: number; text: string } | null = null
    for (const go of gObs.filter(isEvent)) {
        for (const fo of fixed.filter(isEvent)) {
            const score = matchScore(go, fo)
            if (score < 1) continue
            const offset = fo.t - go.t
            const dt = Math.abs(offset)
            if (!best || score > best.score || (score === best.score && dt < best.dt))
                best = { score, dt, offset, text: `${fo.camId}: ${fo.notable ?? fo.people.map(p => p.action).join(", ")}` }
        }
    }
    if (!best) return { offsetMs: 0, offsetErrMs: 5000, matched: null }
    return { offsetMs: Math.round(best.offset), offsetErrMs: 1000, matched: best.text }
}

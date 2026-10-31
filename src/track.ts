// Server-side person tracking. Owner: track A. Pure functions; per-camera state lives in server.ts.
//  1. drop fragments (tiny boxes, arms/hands, no clear top colour)   2. merge duplicate boxes (IoU > 0.5)
//  3. within-camera tracking (IoU / centre distance vs the last 2 frames, greedy one-to-one, top colour must agree)
//  4. new tracks: appearance re-ID against entities seen in the last 120s on any camera, else "new"
import type { Person } from "./shared/types.js"
import { normWords } from "./words.js"

export const COLOURS = ["black", "white", "grey", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "beige", "navy"]
const COLOUR_ALIAS: Record<string, string> = { gray: "grey", navy: "blue", tan: "beige", cream: "beige", maroon: "red", khaki: "beige" }
const FRAGMENT = /\b(arm|arms|hand|hands|sleeve|finger|fingers|wrist|elbow|shoulder|leg|legs|foot|feet)\b/

export interface Look {
    topColour: string | null
    topGarment: string[]
    bottomColour: string | null
    bottomGarment: string[]
    head: string[]
    carrying: string[]
}

function colourOf(text: string): string | null {
    for (const w of text.toLowerCase().split(/[^a-z]+/)) {
        const c = COLOUR_ALIAS[w] ?? w
        if (COLOURS.includes(c)) return c === "navy" ? "blue" : c
    }
    return null
}
const garment = (text: string) => normWords(text).filter(w => w !== "unknown" && w !== "none")

// "top: white t-shirt; bottom: blue jeans; head: short black hair; carrying: none"
export function parseDesc(desc: string): Look {
    const f: Record<string, string> = {}
    for (const part of desc.toLowerCase().split(";")) {
        const i = part.indexOf(":")
        if (i > 0) f[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    const top = f.top ?? "", bottom = f.bottom ?? ""
    return {
        topColour: colourOf(top),
        topGarment: garment(top),
        bottomColour: /unknown/.test(bottom) ? null : colourOf(bottom),
        bottomGarment: garment(bottom),
        head: (f.head ?? "").split(/[^a-z]+/).filter(w => w.length >= 3 && w !== "unknown" && w !== "none" && w !== "and" && w !== "with"),
        carrying: (f.carrying ?? "").trim() ? normWords(f.carrying ?? "").concat(/\bnone\b/.test(f.carrying ?? "") ? ["none"] : []) : []
    }
}

export function isFragment(p: Person): boolean {
    if (p.w * p.h < 0.03) return true
    const d = p.desc.toLowerCase()
    if (!/top:/.test(d)) return true
    const look = parseDesc(d)
    if (!look.topColour) return true
    const topText = d.split(";").find(x => x.trim().startsWith("top:")) ?? ""
    if (FRAGMENT.test(topText) && look.topGarment.every(w => FRAGMENT.test(w))) return true
    return false
}

export function iou(a: Person, b: Person): number {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y)
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h)
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
    const union = a.w * a.h + b.w * b.h - inter
    return union > 0 ? inter / union : 0
}

// Two boxes with IoU > 0.5 are one person (keep the larger).
export function dedupe(people: Person[]): Person[] {
    const sorted = [...people].sort((a, b) => b.w * b.h - a.w * a.h)
    const out: Person[] = []
    for (const p of sorted) if (!out.some(q => iou(p, q) > 0.5)) out.push(p)
    return out
}

const centre = (p: Person) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 })

// Appearance score between two structured descs, and the max possible over fields known in both.
export function reidScore(a: Look, b: Look): { score: number; max: number } {
    let score = 0, max = 0
    const overlap = (x: string[], y: string[]) => x.some(w => y.includes(w))
    if (a.topColour && b.topColour) { max += 2; if (a.topColour === b.topColour) score += 2 }
    if (a.topGarment.length && b.topGarment.length) { max += 2; if (overlap(a.topGarment, b.topGarment)) score += 2 }
    if (a.bottomColour && b.bottomColour) { max += 1; if (a.bottomColour === b.bottomColour) score += 1 }
    if (a.bottomGarment.length && b.bottomGarment.length) { max += 1; if (overlap(a.bottomGarment, b.bottomGarment)) score += 1 }
    if (a.head.length && b.head.length) { max += 1; if (overlap(a.head, b.head)) score += 1 }
    if (a.carrying.length && b.carrying.length) { max += 1; if (overlap(a.carrying, b.carrying)) score += 1 }
    return { score, max }
}

const REID_MIN = 0.6

// Assigns ids: kept from the camera's last 2 frames when the box matches, else re-identified from recent
// entities, else "new" (the site mints a letter). Also returns model-id → assigned-id for remapping heldBy.
export function assignIds(
    people: Person[],
    prevFrames: Person[][], // newest first, ids already assigned
    recent: { id: string; desc: string }[]
): { people: Person[]; idMap: Record<string, string> } {
    const out = people.map(p => ({ ...p }))
    const assigned = new Map<number, string>()
    const used = new Set<string>()

    // within-camera: candidates from frame -1, then frame -2 (for ids not in frame -1)
    const prev: Person[] = []
    const seen = new Set<string>()
    for (const frame of prevFrames.slice(0, 2)) for (const q of frame) if (!seen.has(q.id)) { seen.add(q.id); prev.push(q) }
    const pairs: { i: number; id: string; score: number }[] = []
    out.forEach((p, i) => {
        const lp = parseDesc(p.desc)
        for (const q of prev) {
            const lq = parseDesc(q.desc)
            if (lp.topColour && lq.topColour && lp.topColour !== lq.topColour) continue // never swap a white top for a black one
            const o = iou(p, q)
            let score = 0
            if (o >= 0.3) score = 1 + o
            else {
                const a = centre(p), b = centre(q)
                const d = Math.hypot(a.x - b.x, a.y - b.y)
                const ratio = (p.w * p.h) / Math.max(1e-6, q.w * q.h)
                if (d <= 0.15 && ratio >= 0.5 && ratio <= 2) score = 1 - d
            }
            if (score > 0) pairs.push({ i, id: q.id, score })
        }
    })
    pairs.sort((a, b) => b.score - a.score)
    for (const pr of pairs) {
        if (assigned.has(pr.i) || used.has(pr.id)) continue
        assigned.set(pr.i, pr.id)
        used.add(pr.id)
    }

    // new tracks: appearance re-ID against recent entities not visible on this camera in this frame
    out.forEach((p, i) => {
        if (assigned.has(i)) return
        const lp = parseDesc(p.desc)
        let best: { id: string; s: number } | null = null
        for (const e of recent) {
            if (used.has(e.id)) continue
            const le = parseDesc(e.desc)
            if (!lp.topColour || lp.topColour !== le.topColour) continue
            const { score, max } = reidScore(lp, le)
            if (!max || score < REID_MIN * max) continue
            const s = score / max + (p.id === e.id ? 0.01 : 0) // the model's own suggestion only breaks ties
            if (!best || s > best.s) best = { id: e.id, s }
        }
        if (best) {
            assigned.set(i, best.id)
            used.add(best.id)
        }
    })

    const idMap: Record<string, string> = {}
    out.forEach((p, i) => {
        const id = assigned.get(i) ?? "new"
        if (p.id && p.id !== "new" && id !== "new") idMap[p.id] = id
        p.id = id
    })
    return { people: out, idMap }
}

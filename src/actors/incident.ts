import { Actor, Persisted } from "durable-actors"

import type { IncidentState, RelayCard, Testimony } from "../shared/types.js"

const TESTIMONY_DEADLINE_MS = 10_000

function need(state: IncidentState | null): IncidentState {
    if (!state) throw new Error("incident not opened")
    return state
}

type Result = Pick<IncidentState, "timeline" | "contradictions" | "paths" | "summary">

// One per incident ("inc-N"): the case file. Owner: track C.
// Mutators return the full state; the Relay bridge publishes { type: "incident" } (the actor does not).
export class IncidentActor extends Actor {
    @Persisted state: IncidentState | null = null
    @Persisted testimony: Record<string, Testimony> = {}

    // Marks each witness "asked" and arms the testimony-deadline alarm.
    async open(question: string, window: [number, number], camIds: string[]): Promise<IncidentState> {
        if (this.state) return this.state // idempotent: an incident opens once
        this.state = {
            id: this.id,
            question,
            window,
            status: "gathering",
            witnesses: [...new Set(camIds)].map(camId => ({ camId, status: "asked" as const })),
            timeline: [],
            contradictions: [],
            paths: [],
            summary: null,
            revision: 0,
            transcript: []
        }
        this.alarm.set(Date.now() + TESTIMONY_DEADLINE_MS)
        return this.state
    }

    async get(): Promise<IncidentState | null> {
        return this.state
    }

    async getTestimony(): Promise<Record<string, Testimony>> {
        return this.testimony
    }

    async addTestimony(testimony: Testimony): Promise<IncidentState> {
        const s = need(this.state)
        this.testimony = { ...this.testimony, [testimony.camId]: testimony }
        const w = s.witnesses.find(w => w.camId === testimony.camId)
        if (w) w.status = "answered"
        else s.witnesses.push({ camId: testimony.camId, status: "answered" })
        this.state = { ...s }
        return this.state
    }

    async logRelay(card: RelayCard): Promise<IncidentState> {
        const s = need(this.state)
        if (!s.transcript.some(c => c.id === card.id)) s.transcript = [...s.transcript, card].slice(-200)
        this.state = { ...s }
        return this.state
    }

    async setStatus(status: IncidentState["status"]): Promise<IncidentState> {
        const s = need(this.state)
        this.state = { ...s, status }
        return this.state
    }

    // Stores a new revision; returns the ids of timeline items that changed.
    async setResult(result: Result & { status?: IncidentState["status"] }): Promise<{ incident: IncidentState; changed: string[] }> {
        const s = need(this.state)
        const prev = new Map(s.timeline.map(i => [i.id, i]))
        const changed: string[] = []
        const timeline = result.timeline.map(item => {
            const old = prev.get(item.id)
            const { revisedFrom: _drop, ...clean } = item
            if (!old) {
                changed.push(item.id)
                return clean
            }
            if (old.claim.trim() !== item.claim.trim()) {
                changed.push(item.id)
                return { ...clean, revisedFrom: old.claim }
            }
            return old.revisedFrom ? { ...clean, revisedFrom: old.revisedFrom } : clean
        })
        this.state = {
            ...s,
            timeline,
            contradictions: result.contradictions,
            paths: result.paths,
            summary: result.summary,
            revision: s.revision + 1,
            status: result.status ?? "done"
        }
        return { incident: this.state, changed }
    }

    // Late witness: reopens the case for one more camera.
    async addWitness(camId: string): Promise<IncidentState> {
        const s = need(this.state)
        const witnesses = s.witnesses.filter(w => w.camId !== camId)
        witnesses.push({ camId, status: "asked" })
        this.state = { ...s, witnesses, status: "gathering" }
        this.alarm.set(Date.now() + TESTIMONY_DEADLINE_MS)
        return this.state
    }

    // Testimony deadline: witnesses still "asked" go silent so one dead camera can't stall the case.
    async onAlarm(): Promise<void> {
        const s = this.state
        if (!s) return
        if (!s.witnesses.some(w => w.status === "asked")) return
        this.state = { ...s, witnesses: s.witnesses.map(w => (w.status === "asked" ? { ...w, status: "silent" as const } : w)) }
    }
}

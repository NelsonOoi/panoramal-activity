import { Actor, Persisted } from "durable-actors"
import type { ActorSocket } from "durable-actors"

import { CAMERA_COLORS } from "../shared/types.js"
import type {
    Alert, BlindSpot, CameraKind, CameraMeta, DashEvent, EdgeEvent, IncidentState, Knock, PathPoint, Person, Sighting, SiteEdge, SiteSnapshot
} from "../shared/types.js"

type DashMeta = { role: "dashboard" }

const MATCH_WINDOW_MS = 20_000
const BLIND_SPOT_AFTER_MS = 20_000
const ALERT_DEBOUNCE_MS = 10_000
const MAX_SIGHTINGS = 2000
const CROWD_WINDOW_MS = 2_000 // 2+ entities exiting one camera within this → ignore those exits
const BLIND_SPOT_MIN_EXITS = 3 // unmatched exits on one edge before it is reported as a blind spot

function letterId(n: number): string {
    // 0 → A … 25 → Z, 26 → A2 … 51 → Z2, 52 → A3 …
    const round = Math.floor(n / 26)
    return String.fromCharCode(65 + (n % 26)) + (round ? String(round + 1) : "")
}

function ringPos(i: number): { x: number; y: number } {
    const a = (i * 2 * Math.PI) / 6 - Math.PI / 2
    return { x: +(0.5 + 0.32 * Math.cos(a)).toFixed(3), y: +(0.5 + 0.32 * Math.sin(a)).toFixed(3) }
}

function withTransit(edges: Record<string, SiteEdge>, from: EdgeEvent, to: EdgeEvent) {
    const id = `${from.camId}:${from.edge}->${to.camId}:${to.edge}`
    const existing = edges[id]
    const ms = Math.max(0, to.t - from.t)
    const edge: SiteEdge = existing
        ? { ...existing, transits: [...existing.transits, ms].slice(-50) }
        : { id, from: { camId: from.camId, edge: from.edge }, to: { camId: to.camId, edge: to.edge }, transits: [ms] }
    return { edges: { ...edges, [id]: edge }, edge, isNew: !existing }
}

// The actor's ONE alarm is multiplexed: earliest of (blind-spot deadline of any pending exit, escalation of any raised alert).
function nextAlarm(pending: EdgeEvent[], alerts: Alert[] = []): number | null {
    const times = [
        ...pending.map(e => e.t + BLIND_SPOT_AFTER_MS + 100),
        ...alerts.filter(a => a.status === "raised" && a.escalateAt).map(a => a.escalateAt)
    ]
    if (!times.length) return null
    return Math.max(Date.now() + 250, Math.min(...times))
}

const ESCALATE_AFTER_MS = 30_000

function normAlert(a: Alert): Alert {
    // Records from before alert lifecycles existed: treat as notable and settled.
    return { ...a, kind: a.kind ?? "notable", status: a.status ?? "acknowledged", escalateAt: a.escalateAt ?? 0, history: a.history ?? [] }
}

// One per site ("site"): directory, learned layout, entities, alerts, knocks.
// The dashboard's only websocket connects here. Owner: track A.
export class SiteActor extends Actor<DashMeta, never, DashEvent> {
    @Persisted cameras: Record<string, CameraMeta> = {}
    @Persisted edges: Record<string, SiteEdge> = {}
    @Persisted blindSpots: Record<string, BlindSpot> = {}
    @Persisted pendingExits: EdgeEvent[] = []
    @Persisted recentEntries: EdgeEvent[] = [] // entries that arrived before their exit was detected
    @Persisted recentExits: EdgeEvent[] = [] // every exit in the last ~30s (crowd guard)
    @Persisted exitMisses: Record<string, number> = {} // unmatched exits per "camId:edge"; blind spot at >= 3
    @Persisted entities: Record<string, { desc: string; lastSeen?: number }> = {}
    @Persisted sightings: Sighting[] = []
    @Persisted alerts: Alert[] = []
    @Persisted knocks: Record<string, Knock> = {}
    @Persisted incidents: { id: string; window: [number, number] }[] = []
    @Persisted currentIncidentId: string | null = null
    @Persisted escalations: { id: string; by: "alarm" | "tick" }[] = [] // escalated, not yet handed to the server
    @Persisted epoch: string = ""
    @Persisted seq: { cam: number; entity: number; alert: number; incident: number } = { cam: 0, entity: 0, alert: 0, incident: 0 }

    async onConnect(socket: ActorSocket<DashMeta, DashEvent>) {
        socket.send({ type: "snapshot", site: await this.snapshot() })
    }

    async snapshot(): Promise<SiteSnapshot> {
        return {
            cameras: Object.values(this.cameras),
            edges: Object.values(this.edges),
            blindSpots: Object.values(this.blindSpots),
            entities: Object.entries(this.entities).map(([id, e]) => ({ id, desc: e.desc })),
            currentIncidentId: this.currentIncidentId,
            knocks: Object.values(this.knocks),
            alerts: this.alerts.slice(0, 20).map(normAlert)
        }
    }

    // Any backend code sends dashboard events through here (see src/publish.ts).
    async publish(event: DashEvent): Promise<void> {
        this.broadcast(event)
    }

    // Assigns the next id ("cam-N" or "guest-xxxx") and colour. Fixed cameras are auto-placed on a ring.
    async addCamera(kind: CameraKind): Promise<CameraMeta> {
        let id: string
        if (kind === "fixed") {
            this.seq = { ...this.seq, cam: this.seq.cam + 1 }
            id = `cam-${this.seq.cam}`
        } else {
            do id = `guest-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`
            while (this.cameras[id])
        }
        const n = Object.keys(this.cameras).length
        const fixedCount = Object.values(this.cameras).filter(c => c.kind === "fixed").length
        const meta: CameraMeta = {
            id,
            kind,
            color: CAMERA_COLORS[n % CAMERA_COLORS.length],
            pos: kind === "fixed" ? ringPos(fixedCount) : null,
            facing: 0,
            online: kind === "fixed",
            observations: 0,
            offsetMs: 0,
            offsetErrMs: kind === "fixed" ? 50 : 5000,
            admitted: kind === "fixed"
        }
        this.cameras = { ...this.cameras, [id]: meta }
        this.broadcast({ type: "camera", camera: meta })
        return meta
    }

    // Stores the latest meta and broadcasts { type: "camera" }.
    async putCamera(meta: CameraMeta): Promise<void> {
        this.cameras = { ...this.cameras, [meta.id]: meta }
        this.broadcast({ type: "camera", camera: meta })
    }

    async listCameras(): Promise<CameraMeta[]> {
        return Object.values(this.cameras)
    }

    // Replaces "new" ids with fresh entity letters and refreshes descriptions.
    async resolveEntities(people: Person[]): Promise<Person[]> {
        const entities = { ...this.entities }
        const used = new Set<string>()
        const out = people.map(p => {
            let id = p.id
            if (!id || id === "new" || !entities[id] || used.has(id)) {
                id = letterId(this.seq.entity)
                this.seq = { ...this.seq, entity: this.seq.entity + 1 }
            }
            used.add(id)
            if (p.desc) entities[id] = { ...entities[id], desc: p.desc }
            else if (!entities[id]) entities[id] = { desc: "person" }
            return { ...p, id }
        })
        this.entities = entities
        return out
    }

    async knownEntities(): Promise<{ id: string; desc: string }[]> {
        return Object.entries(this.entities).map(([id, e]) => ({ id, desc: e.desc }))
    }

    // Entities seen anywhere in the last `withinMs`, most recent first (for the vision prompt's re-id list).
    async recentEntities(withinMs = 120_000, max = 10): Promise<{ id: string; desc: string }[]> {
        const since = Date.now() - withinMs
        return Object.entries(this.entities)
            .filter(([, e]) => (e.lastSeen ?? 0) >= since)
            .sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0))
            .slice(0, max)
            .map(([id, e]) => ({ id, desc: e.desc }))
    }

    async addSightings(sightings: Sighting[]): Promise<void> {
        if (!sightings.length) return
        const all = this.sightings.concat(sightings)
        this.sightings = all.length > MAX_SIGHTINGS ? all.slice(all.length - MAX_SIGHTINGS) : all
        const entities = { ...this.entities }
        for (const s of sightings) {
            const e = entities[s.entityId]
            if (e && (e.lastSeen ?? 0) < s.t) entities[s.entityId] = { ...e, lastSeen: s.t }
        }
        this.entities = entities
        await this.sweep("sighting")
    }

    // Exit→entry matching learns an edge, unless the match is ambiguous (see guards below).
    async recordExit(e: EdgeEvent): Promise<void> {
        const now = Date.now()
        this.recentEntries = this.recentEntries.filter(x => now - x.t < MATCH_WINDOW_MS + 10_000)
        this.recentExits = this.recentExits.filter(x => now - x.t < MATCH_WINDOW_MS + 10_000)
        // Crowd guard: 2+ different entities leaving the same camera within 2s (any edge, center included)
        // → learn nothing from any of them.
        const crowd = this.recentExits.filter(x => x.camId === e.camId && x.entityId !== e.entityId && Math.abs(x.t - e.t) <= CROWD_WINDOW_MS)
        this.recentExits = [...this.recentExits, e]
        // "center" = faded out mid-frame, not a real exit: never counts towards edges or blind spots.
        if (e.edge === "center") return
        if (crowd.length) {
            this.pendingExits = this.pendingExits.filter(
                x => !(x.camId === e.camId && Math.abs(x.t - e.t) <= CROWD_WINDOW_MS)
            )
            return
        }

        // An entry on another camera may already have arrived (exits are detected ~2 frames late).
        const cands = this.recentEntries.filter(x => x.entityId === e.entityId && x.camId !== e.camId && x.t >= e.t && x.t - e.t <= MATCH_WINDOW_MS)
        if (cands.length > 1) {
            // Ambiguous: the exit could match several entries. Drop them all, learn nothing.
            this.recentEntries = this.recentEntries.filter(x => !cands.includes(x))
            return
        }
        if (cands.length === 1) {
            const entry = cands[0]
            this.recentEntries = this.recentEntries.filter(x => x !== entry)
            const r = withTransit(this.edges, e, entry)
            this.edges = r.edges
            this.broadcast({ type: "edge", edge: r.edge, isNew: r.isNew })
            return
        }
        this.pendingExits = [...this.pendingExits, e]
        const at = nextAlarm(this.pendingExits, this.alerts)
        if (at) this.alarm.set(at)
    }

    async recordEntry(e: EdgeEvent): Promise<void> {
        // Same entity coming back on the same camera: vision flicker, not a transit or a blind spot.
        this.pendingExits = this.pendingExits.filter(x => !(x.entityId === e.entityId && x.camId === e.camId))
        const cands = this.pendingExits.filter(x => x.entityId === e.entityId && x.camId !== e.camId && e.t >= x.t && e.t - x.t <= MATCH_WINDOW_MS)
        if (cands.length > 1) {
            // Ambiguous: the entry could match several exits. Drop them all (not blind spots either), learn nothing.
            this.pendingExits = this.pendingExits.filter(x => !cands.includes(x))
            return
        }
        if (cands.length === 1) {
            const from = cands[0]
            this.pendingExits = this.pendingExits.filter(x => x !== from)
            const r = withTransit(this.edges, from, e)
            this.edges = r.edges
            this.broadcast({ type: "edge", edge: r.edge, isNew: r.isNew })
            return
        }
        const now = Date.now()
        this.recentEntries = [...this.recentEntries.filter(x => now - x.t < MATCH_WINDOW_MS + 10_000), e]
    }

    // Unmatched exits older than 20s count towards a blind spot on that edge.
    // Also escalates raised alerts past escalateAt (the primary escalation trigger).
    async onAlarm() {
        await this.sweep("alarm")
    }

    // Server backstop every 2s (alarms can be lost when the actor host hot-reloads). Returns alerts escalated
    // since the last tick (by the alarm or by this tick) so the server can open their incidents.
    async tick(): Promise<{ alert: Alert; by: "alarm" | "tick" }[]> {
        await this.sweep("tick")
        const out = this.escalations
            .map(e => ({ alert: this.alerts.find(a => a.id === e.id), by: e.by }))
            .filter((e): e is { alert: Alert; by: "alarm" | "tick" } => !!e.alert)
        this.escalations = []
        return out
    }

    // Expires pending exits (blind spots) and, unless exitsOnly, escalates overdue raised alerts.
    async sweep(by: "alarm" | "tick" | "sighting"): Promise<void> {
        const now = Date.now()
        if (by !== "sighting") {
            // The tick is only a backstop: give the alarm a 1.5s head start.
            const grace = by === "tick" ? 1_500 : 0
            const due = this.alerts.filter(a => a.status === "raised" && a.escalateAt && a.escalateAt + grace <= now)
            if (due.length) {
                this.alerts = this.alerts.map(a =>
                    due.includes(a) ? { ...a, status: "escalated" as const, history: [...(a.history ?? []), { status: "escalated" as const, at: now }] } : a
                )
                for (const d of due) {
                    const a = this.alerts.find(x => x.id === d.id)!
                    this.escalations = [...this.escalations, { id: a.id, by: by as "alarm" | "tick" }]
                    this.broadcast({ type: "alert", alert: a })
                }
            }
        }
        const expired = this.pendingExits.filter(x => now - x.t >= BLIND_SPOT_AFTER_MS)
        if (expired.length) {
            this.pendingExits = this.pendingExits.filter(x => now - x.t < BLIND_SPOT_AFTER_MS)
            for (const x of expired) {
                const key = `${x.camId}:${x.edge}`
                const count = (this.exitMisses[key] ?? 0) + 1
                this.exitMisses = { ...this.exitMisses, [key]: count }
                // Blind spot only after BLIND_SPOT_MIN_EXITS unmatched exits on the same edge.
                if (count >= BLIND_SPOT_MIN_EXITS) {
                    const spot: BlindSpot = { camId: x.camId, edge: x.edge, count }
                    this.blindSpots = { ...this.blindSpots, [key]: spot }
                    this.broadcast({ type: "blind-spot", spot })
                }
            }
        }
        const at = nextAlarm(this.pendingExits, this.alerts)
        if (at) this.alarm.set(at)
    }

    // Camera-to-camera paths per entity in [t0, t1], gaps marked inferred.
    async paths(t0: number, t1: number): Promise<IncidentState["paths"]> {
        const byEntity: Record<string, Sighting[]> = {}
        for (const s of this.sightings) {
            if (s.t < t0 || s.t > t1) continue
            ;(byEntity[s.entityId] ??= []).push(s)
        }
        const out: IncidentState["paths"] = []
        for (const [entityId, list] of Object.entries(byEntity)) {
            list.sort((a, b) => a.t - b.t)
            // Collapse consecutive same-camera sightings to first + last.
            const runs: Sighting[][] = []
            for (const s of list) {
                const last = runs[runs.length - 1]
                if (last && last[0].camId === s.camId) last.push(s)
                else runs.push([s])
            }
            const points: PathPoint[] = []
            let prevLast: Sighting | null = null
            for (const run of runs) {
                const first = run[0]
                let inferred = false
                if (prevLast) {
                    const spot = this.blindSpots[`${prevLast.camId}:${prevLast.edge}`]
                    const edge = Object.values(this.edges).find(
                        e => e.from.camId === prevLast!.camId && e.to.camId === first.camId && (e.from.edge === prevLast!.edge || e.to.edge === first.edge)
                    ) ?? Object.values(this.edges).find(e => e.from.camId === prevLast!.camId && e.to.camId === first.camId)
                    const gap = first.t - prevLast.t
                    if (spot) inferred = true
                    else if (edge && edge.transits.length) {
                        const mean = edge.transits.reduce((a, b) => a + b, 0) / edge.transits.length
                        inferred = gap > 2 * Math.max(mean, 1000)
                    } else inferred = gap > 10_000
                }
                points.push({ t: first.t, camId: first.camId, inferred, frameRef: first.frameRef })
                if (run.length > 1) {
                    const last = run[run.length - 1]
                    points.push({ t: last.t, camId: last.camId, inferred: false, frameRef: last.frameRef })
                }
                prevLast = run[run.length - 1]
            }
            out.push({ entityId, desc: this.entities[entityId]?.desc ?? list[list.length - 1].desc, points })
        }
        return out
    }

    // Debug: layout-learning internals.
    async debugLayout(): Promise<{ pendingExits: EdgeEvent[]; recentEntries: EdgeEvent[]; recentExits: EdgeEvent[]; exitMisses: Record<string, number>; alarmAt: number | null; now: number }> {
        return { pendingExits: this.pendingExits, recentEntries: this.recentEntries, recentExits: this.recentExits, exitMisses: this.exitMisses, alarmAt: this.alarm.get(), now: Date.now() }
    }

    async layout(): Promise<{ edges: SiteEdge[]; blindSpots: BlindSpot[] }> {
        return { edges: Object.values(this.edges), blindSpots: Object.values(this.blindSpots) }
    }

    async resetLayout(): Promise<void> {
        this.edges = {}
        this.blindSpots = {}
        this.pendingExits = []
        this.recentEntries = []
        this.recentExits = []
        this.exitMisses = {}
        this.entities = {}
        this.sightings = []
        this.alerts = []
        this.escalations = []
        this.knocks = {}
        this.incidents = []
        this.currentIncidentId = null
        this.seq = { ...this.seq, entity: 0 }
    }

    // Full demo reset: also forgets every camera and resets the camera/entity/alert counters (next camera cam-1, first entity A).
    async wipe(): Promise<void> {
        await this.resetLayout()
        this.cameras = {}
        // The incident counter is NOT reset: IncidentActor("inc-N") instances persist, and reusing an id would reopen an old case.
        this.seq = { cam: 0, entity: 0, alert: 0, incident: this.seq.incident }
        this.epoch = Math.random().toString(36).slice(2, 10)
        this.alarm.delete()
    }

    // Changes on every wipe; phones keep a camera id only within one epoch.
    async getEpoch(): Promise<string> {
        if (!this.epoch) this.epoch = Math.random().toString(36).slice(2, 10)
        return this.epoch
    }

    // Returns false when debounced (max one alert per camera per kind per 10s).
    async addAlert(alert: Alert): Promise<boolean> {
        return (await this.createAlert(alert)) !== null
    }

    // Stores a new alert (status "raised", escalates in 30s unless acknowledged or investigated), broadcasts it,
    // and returns it; null when debounced (one per camera per kind per 10s). Assigns "al-N".
    async createAlert(input: Pick<Alert, "camId" | "t" | "text" | "frameRef"> & { kind?: Alert["kind"]; id?: string }): Promise<Alert | null> {
        const kind = input.kind ?? "notable"
        if (this.alerts.some(a => a.camId === input.camId && (a.kind ?? "notable") === kind && Math.abs(a.t - input.t) < ALERT_DEBOUNCE_MS)) return null
        let id = input.id
        if (!id) {
            this.seq = { ...this.seq, alert: this.seq.alert + 1 }
            id = `al-${this.seq.alert}`
        }
        const now = Date.now()
        const stored: Alert = {
            id, camId: input.camId, t: input.t, text: input.text, frameRef: input.frameRef, kind,
            status: "raised", escalateAt: input.t + ESCALATE_AFTER_MS, history: [{ status: "raised", at: now }]
        }
        this.alerts = [stored, ...this.alerts].slice(0, 20)
        this.broadcast({ type: "alert", alert: stored })
        const at = nextAlarm(this.pendingExits, this.alerts)
        if (at) this.alarm.set(at)
        return stored
    }

    // An incident opened over [t0, t1]: every still-"raised" alert inside it becomes "investigating" with that incId
    // (stops its countdown, so two toasts for one event never become two cases). Returns the updated alerts.
    async claimAlerts(window: [number, number], incId: string): Promise<Alert[]> {
        const now = Date.now()
        const hit = this.alerts.filter(a => a.status === "raised" && a.t >= window[0] && a.t <= window[1])
        if (!hit.length) return []
        this.alerts = this.alerts.map(a =>
            hit.includes(a) ? { ...normAlert(a), status: "investigating" as const, incId, history: [...(a.history ?? []), { status: "investigating" as const, at: now }] } : a
        )
        const out = this.alerts.filter(a => hit.some(h => h.id === a.id))
        for (const a of out) this.broadcast({ type: "alert", alert: a })
        const at = nextAlarm(this.pendingExits, this.alerts)
        if (at) this.alarm.set(at)
        return out
    }

    // Status change (acknowledged / investigating / escalated+incId). Same status → only incId is updated.
    async updateAlert(id: string, status: Alert["status"], incId?: string): Promise<Alert | null> {
        const prev = this.alerts.find(a => a.id === id)
        if (!prev) return null
        const cur = normAlert(prev)
        const next: Alert = {
            ...cur,
            status,
            ...(incId ? { incId } : {}),
            history: cur.status === status ? cur.history : [...cur.history, { status, at: Date.now() }]
        }
        this.alerts = this.alerts.map(a => (a.id === id ? next : a))
        this.broadcast({ type: "alert", alert: next })
        const at = nextAlarm(this.pendingExits, this.alerts)
        if (at) this.alarm.set(at)
        return next
    }

    async getAlert(id: string): Promise<Alert | null> {
        const a = this.alerts.find(a => a.id === id)
        return a ? normAlert(a) : null
    }

    // Returns an open incident whose window overlaps, or a new "inc-N".
    // fresh: always create a new incident (no dedupe on overlapping windows).
    async openIncident(window: [number, number], opts?: { fresh?: boolean }): Promise<{ incId: string; isNew: boolean }> {
        const hit = opts?.fresh ? undefined : this.incidents.find(i => i.window[0] <= window[1] && window[0] <= i.window[1])
        if (hit) {
            this.currentIncidentId = hit.id
            return { incId: hit.id, isNew: false }
        }
        this.seq = { ...this.seq, incident: this.seq.incident + 1 }
        const id = `inc-${this.seq.incident}`
        this.incidents = [...this.incidents, { id, window }]
        this.currentIncidentId = id
        return { incId: id, isNew: true }
    }

    // Forgets an incident id the server found already in use by an old IncidentActor (e.g. from before a wipe).
    async dropIncident(id: string): Promise<void> {
        this.incidents = this.incidents.filter(i => i.id !== id)
        if (this.currentIncidentId === id) this.currentIncidentId = null
    }

    async putKnock(knock: Knock): Promise<Knock> {
        this.knocks = { ...this.knocks, [knock.guestId]: knock }
        return knock
    }

    async getKnock(guestId: string): Promise<Knock | null> {
        return this.knocks[guestId] ?? null
    }
}

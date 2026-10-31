import { Actor, Persisted } from "durable-actors"

import type { AlertKind, CameraMeta, Edge, EdgeEvent, Observation } from "../shared/types.js"
import { isValuable } from "../words.js"
import { SiteActor } from "./site.js"

const HEARTBEAT_MS = 5_000
const WARMUP_MS = 60_000 // no alerts for this long after a camera's first frame (baseline settles)
const LOG_WINDOW_MS = 10 * 60_000
const EXIT_AFTER_MISSED = 2 // consecutive frames missing → exit
const ENTER_AFTER_SEEN = 2 // consecutive frames seen → entry

export function edgeOf(p: { x: number; y: number; w: number; h: number }): Edge {
    const cx = p.x + p.w / 2
    const cy = p.y + p.h / 2
    if (cx < 0.15) return "left"
    if (cx > 0.85) return "right"
    if (cy < 0.15) return "top"
    if (cy > 0.85) return "bottom"
    return "center"
}

// ---------- big-change detection (no LLM calls: diffs of the camera's own observations) ----------
// Tuned for a crowded hall: only valuables, stable evidence, occlusion-aware. See README-style notes in the report.

const HIST = 12 // analysed frames of presence history kept per label ("1"/"0", newest last)
const GONE_BEFORE = 6 // window before the absence…
const GONE_BEFORE_MIN = 5 // …in which the object must have been present this many times
const GONE_ABSENT = 3 // consecutive absent frames before "gone"
const LEFT_FRAMES = 5 // consecutive unattended frames before "left unattended"
const LEFT_NEAR = 0.25 // a person this close (frame coords) attends the object
const CROWD_DELTA = 4 // people-count change…
const CROWD_FRAMES = 3 // …that persists this many frames

export interface ObjTrack {
    hist: string
    firstFrame: number // camera frame number when first seen
    x: number
    y: number
    near: string | null // nearest other object when last seen
    heldBy: string | null
    unattended: number // consecutive present frames with nobody within LEFT_NEAR
    firedGone: boolean
    firedLeft: boolean
}
export interface DetectState {
    frameNo: number
    objs: Record<string, ObjTrack>
    crowdBase: number | null
    crowdPending: { count: number; frames: number } | null
}
export const freshDetect = (): DetectState => ({ frameNo: 0, objs: {}, crowdBase: null, crowdPending: null })

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const norm = (label: string) => label.trim().toLowerCase()

function distToPerson(o: { x: number; y: number }, p: { x: number; y: number; w: number; h: number }) {
    const dx = Math.max(p.x - o.x, 0, o.x - (p.x + p.w))
    const dy = Math.max(p.y - o.y, 0, o.y - (p.y + p.h))
    return Math.hypot(dx, dy)
}

// object-gone: present in >= 5 of the 6 analysed frames before the absence, absent for >= 3, and nobody's box
// covers its last position (that is occlusion, not removal). Re-checked each absent frame until the history runs out.
function goneCheck(label: string, t: ObjTrack, people: Observation["people"], alerts: { kind: AlertKind; text: string }[]): ObjTrack {
    const trailing = t.hist.length - (t.hist.lastIndexOf("1") + 1)
    if (trailing >= GONE_ABSENT) t = { ...t, firedLeft: false }
    if (!isValuable(label) || t.firedGone || trailing < GONE_ABSENT) return t
    const before = t.hist.slice(0, t.hist.length - trailing).slice(-GONE_BEFORE)
    if (before.length < GONE_BEFORE || [...before].filter(c => c === "1").length < GONE_BEFORE_MIN) return t
    if (people.some(p => distToPerson(t, p) <= 0.02)) return t // occluded
    const where = t.near && SURFACE.test(t.near) ? ` from the ${t.near}` : "" // only name where it stood, never another object
    const who = t.heldBy ? ` (last held by ${t.heldBy})` : ""
    alerts.push({ kind: "object-gone", text: `${cap(label)} is gone${where}${who}` })
    return { ...t, firedGone: true }
}

// Surfaces an object can be taken from; "gone from the phone" made no sense.
const SURFACE = /\b(table|desk|counter|shelf|bench|chair|floor|cabinet|cart|stand|bed|sofa|couch)\b/i

export function detect(state: DetectState, obs: Observation, heartbeat: boolean): { state: DetectState; alerts: { kind: AlertKind; text: string }[] } {
    const alerts: { kind: AlertKind; text: string }[] = []
    const st: DetectState = { ...state, objs: { ...state.objs } }

    // crowd: people count changes by >= CROWD_DELTA and stays changed for CROWD_FRAMES frames (notify only)
    const n = obs.people.length
    if (st.crowdBase === null) st.crowdBase = n
    else if (Math.abs(n - st.crowdBase) >= CROWD_DELTA) {
        const p = st.crowdPending
        const same = p && Math.sign(p.count - st.crowdBase) === Math.sign(n - st.crowdBase)
        st.crowdPending = same ? { count: n, frames: p!.frames + 1 } : { count: n, frames: 1 }
        if (st.crowdPending.frames >= CROWD_FRAMES) {
            const d = n - st.crowdBase
            alerts.push({ kind: "crowd", text: d > 0 ? `${d} people arrived` : `${-d} people left` })
            st.crowdBase = n
            st.crowdPending = null
        }
    } else {
        st.crowdBase = n
        st.crowdPending = null
    }

    const present = new Map<string, Observation["objects"][number]>()
    for (const o of obs.objects) if (o.label) present.set(norm(o.label), o)

    // Heartbeat frames are copies of the last vision result: absence evidence only ("0"), never presence.
    if (heartbeat) {
        for (const [label, prev] of Object.entries(st.objs)) {
            if (present.has(label)) continue
            st.objs[label] = goneCheck(label, { ...prev, hist: (prev.hist + "0").slice(-HIST) }, obs.people, alerts)
        }
        return { state: st, alerts }
    }
    st.frameNo = state.frameNo + 1
    const peopleIds = new Set(obs.people.map(p => p.id))

    for (const [label, o] of present) {
        const prev = st.objs[label]
        let near: string | null = null
        let best = 0.25
        for (const [other, oo] of present) {
            if (other === label) continue
            const d = Math.hypot(oo.x - o.x, oo.y - o.y)
            if (d < best) { best = d; near = other }
        }
        const t: ObjTrack = prev
            ? { ...prev, hist: (prev.hist + "1").slice(-HIST) }
            : { hist: "1", firstFrame: st.frameNo, x: 0, y: 0, near: null, heldBy: null, unattended: 0, firedGone: false, firedLeft: false }
        t.x = o.x
        t.y = o.y
        t.near = near ?? t.near
        if (o.heldBy) t.heldBy = o.heldBy
        t.firedGone = false
        // object-left: a NEW valuable (not in the opening scene), unattended for LEFT_FRAMES consecutive frames
        const attended = (o.heldBy ? peopleIds.has(o.heldBy) : false) || obs.people.some(p => distToPerson(o, p) <= LEFT_NEAR)
        t.unattended = attended ? 0 : t.unattended + 1
        if (isValuable(label) && !t.firedLeft && t.firstFrame > 3 && t.unattended >= LEFT_FRAMES) {
            alerts.push({ kind: "object-left", text: `${cap(label)} left unattended${t.near ? ` by the ${t.near}` : ""}` })
            t.firedLeft = true
        }
        st.objs[label] = t
    }
    for (const [label, prev] of Object.entries(st.objs)) {
        if (present.has(label)) continue
        const t = goneCheck(label, { ...prev, hist: (prev.hist + "0").slice(-HIST), unattended: 0 }, obs.people, alerts)
        if (!t.hist.includes("1")) delete st.objs[label] // unseen for HIST frames: forget
        else st.objs[label] = t
    }
    return { state: st, alerts }
}

// One per camera stream: the witness. Owner: track A.
export class CameraActor extends Actor {
    @Persisted meta: CameraMeta | null = null
    @Persisted lastFrameAt = 0 // wall clock of the last ingest
    @Persisted detectState: DetectState = freshDetect()
    @Persisted firstFrameAt = 0 // wall clock of the first frame since init; alerts start WARMUP_MS later
    @Persisted log: Observation[] = [] // rolling, last ~10 minutes
    // hits = consecutive frames seen; an entity is "in view" (entered) once hits >= 2.
    @Persisted visible: Record<string, { lastSeen: number; edge: string; missed: number; hits?: number; firstSeen?: number; firstEdge?: string }> = {}

    async init(meta: CameraMeta): Promise<CameraMeta> {
        this.meta = meta
        this.log = []
        this.visible = {}
        this.detectState = freshDetect()
        this.firstFrameAt = 0
        this.lastFrameAt = Date.now()
        if (meta.online) this.alarm.set(Date.now() + HEARTBEAT_MS)
        return meta
    }

    async info(): Promise<CameraMeta | null> {
        return this.meta
    }

    // Test hook: end the warm-up now.
    async skipWarmup(): Promise<void> {
        this.firstFrameAt = Date.now() - WARMUP_MS
    }

    // Object labels this camera has seen recently (for consistent labelling in the vision prompt).
    async trackedLabels(): Promise<string[]> {
        return Object.entries(this.detectState?.objs ?? {})
            .sort((a, b) => b[1].hist.lastIndexOf("1") - a[1].hist.lastIndexOf("1"))
            .slice(0, 12)
            .map(([label]) => label)
    }

    // Appends to the log, diffs `visible`, detects big changes, re-arms the heartbeat alarm.
    async ingest(
        obs: Observation,
        opts?: { heartbeat?: boolean }
    ): Promise<{ camera: CameraMeta; entries: EdgeEvent[]; exits: EdgeEvent[]; alerts: { kind: AlertKind; text: string }[]; warmingUp: boolean }> {
        if (!this.meta) throw new Error(`camera ${obs.camId} not initialised`)
        const log = this.log.filter(o => o.t >= obs.t - LOG_WINDOW_MS)
        log.push(obs)
        this.log = log

        const entries: EdgeEvent[] = []
        const exits: EdgeEvent[] = []
        const visible = { ...this.visible }
        const seen = new Set<string>()
        for (const p of obs.people) {
            if (seen.has(p.id)) continue
            seen.add(p.id)
            const edge = edgeOf(p)
            const prev = visible[p.id]
            // Hysteresis: a new entity needs ENTER_AFTER_SEEN consecutive frames before it counts as entered.
            // (Unconfirmed entities are dropped on their first miss, so `prev` here means "seen last frame" or "confirmed".)
            const hits = prev ? (prev.hits ?? ENTER_AFTER_SEEN) + 1 : 1
            const firstSeen = prev ? prev.firstSeen ?? prev.lastSeen : obs.t
            const firstEdge = prev ? prev.firstEdge ?? prev.edge : edge
            if (hits === ENTER_AFTER_SEEN) entries.push({ entityId: p.id, camId: obs.camId, edge: firstEdge as Edge, t: firstSeen })
            visible[p.id] = { lastSeen: obs.t, edge, missed: 0, hits, firstSeen, firstEdge }
        }
        for (const [id, v] of Object.entries(visible)) {
            if (seen.has(id)) continue
            const confirmed = (v.hits ?? ENTER_AFTER_SEEN) >= ENTER_AFTER_SEEN
            if (!confirmed) {
                delete visible[id] // seen once then gone: never entered, so it can't exit either
                continue
            }
            const missed = v.missed + 1
            if (missed >= EXIT_AFTER_MISSED) {
                exits.push({ entityId: id, camId: obs.camId, edge: v.edge as Edge, t: v.lastSeen })
                delete visible[id]
            } else visible[id] = { ...v, missed }
        }
        this.visible = visible

        if (!this.firstFrameAt) this.firstFrameAt = Date.now()
        const warmingUp = Date.now() - this.firstFrameAt < WARMUP_MS
        let alerts: { kind: AlertKind; text: string }[] = []
        if (this.meta.kind === "fixed") {
            const r = detect(this.detectState ?? freshDetect(), obs, !!opts?.heartbeat)
            this.detectState = r.state // the baseline keeps building during warm-up…
            alerts = warmingUp ? [] : r.alerts // …but nothing is raised
        }

        this.lastFrameAt = Date.now()
        this.meta = { ...this.meta, online: true, observations: this.meta.observations + 1 }
        this.alarm.set(Date.now() + HEARTBEAT_MS)
        return { camera: this.meta, entries, exits, alerts, warmingUp }
    }

    // Observations in [t0, t1] (site time), offset already applied.
    async recall(t0: number, t1: number): Promise<Observation[]> {
        const off = this.meta?.offsetMs ?? 0
        return this.log
            .map(o => (off ? { ...o, t: o.t + off } : o))
            .filter(o => o.t >= t0 && o.t <= t1)
    }

    async update(patch: Partial<Pick<CameraMeta, "pos" | "facing" | "offsetMs" | "offsetErrMs" | "admitted" | "online">>): Promise<CameraMeta> {
        if (!this.meta) throw new Error("camera not initialised")
        this.meta = { ...this.meta, ...patch }
        return this.meta
    }

    // Called by the server every 2s as a backstop: alarms can be lost when the actor host hot-reloads.
    async checkHeartbeat(): Promise<boolean> {
        if (!this.meta?.online) return false
        const last = this.lastFrameAt || this.log[this.log.length - 1]?.t || 0
        if (Date.now() - last < HEARTBEAT_MS) {
            if (!this.alarm.get()) this.alarm.set(last + HEARTBEAT_MS)
            return false
        }
        await this.onAlarm()
        return true
    }

    // Heartbeat: no frame for 5s → offline, flush exits for everyone still in view, tell the site.
    async onAlarm() {
        if (!this.meta || !this.meta.online) return
        const exits: EdgeEvent[] = Object.entries(this.visible).filter(([, v]) => (v.hits ?? ENTER_AFTER_SEEN) >= ENTER_AFTER_SEEN).map(([id, v]) => ({
            entityId: id, camId: this.meta!.id, edge: v.edge as Edge, t: v.lastSeen
        }))
        this.visible = {}
        this.meta = { ...this.meta, online: false }
        try {
            const site = SiteActor.get("site")
            await site.putCamera(this.meta)
            // Guests don't teach layout.
            if (this.meta.kind === "fixed") for (const e of exits) await site.recordExit(e)
        } catch (err) {
            console.error(`[camera ${this.meta.id}] actor-to-actor call failed:`, err)
        }
    }
}

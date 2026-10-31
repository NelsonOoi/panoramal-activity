// Shared contract between actors, server, relay bridge and front end.
// Change only by agreement: every track builds against these shapes.

export type Edge = "left" | "right" | "top" | "bottom" | "center"
export type CameraKind = "fixed" | "upload"

// Per-camera tint, greyscale only (no hues anywhere in the UI). Kept for compatibility; the UI should not rely on it.
export const CAMERA_COLORS = ["#fafafa", "#d4d4d8", "#a1a1aa", "#e4e4e7", "#71717a", "#f4f4f5"] as const // greyscale: no per-camera hues (style rule)

export interface CameraMeta {
    id: string // "cam-1", "guest-7f3a"
    kind: CameraKind
    color: string
    pos: { x: number; y: number } | null // 0–1 on the floor plan; null until placed
    facing: number // degrees, 0 = up
    online: boolean
    observations: number
    offsetMs: number // added to the camera's timestamps to get site time
    offsetErrMs: number
    admitted: boolean // guests start false until the operator approves the knock
}

export interface Person {
    id: string // entity id ("A", "B", …) or "new" before the server assigns one
    desc: string
    x: number
    y: number
    w: number
    h: number // bounding box, 0–1 in the frame, x/y = top-left
    action: string
}

export interface Observation {
    camId: string
    t: number // site time, ms
    frameRef: string // "/frames/<camId>/<t>.jpg"
    people: Person[]
    objects: { label: string; x: number; y: number; heldBy?: string }[]
    notable: string | null // "bag picked up" → alert
}

// What the vision model returns for one frame (the server adds camId/t/frameRef).
export type VisionResult = Omit<Observation, "camId" | "t" | "frameRef">

export interface Sighting {
    entityId: string
    camId: string
    t: number
    edge: Edge
    desc: string
    action: string
    frameRef: string
}

export interface EdgeEvent {
    entityId: string
    camId: string
    edge: Edge
    t: number
}

export interface SiteEdge {
    id: string // `${from.camId}:${from.edge}->${to.camId}:${to.edge}`
    from: { camId: string; edge: Edge }
    to: { camId: string; edge: Edge }
    transits: number[] // ms
}

export interface BlindSpot {
    camId: string
    edge: Edge
    count: number
}

// A path is drawn camera to camera: each point sits at its camera's node on the map.
export interface PathPoint {
    t: number
    camId: string
    inferred: boolean // true for gap segments nobody saw
    frameRef?: string
}

export type AlertKind = "notable" | "object-gone" | "object-left" | "crowd" | "tamper"

export interface Alert {
    id: string
    camId: string
    t: number
    text: string // "Yellow tote is gone from the table"
    frameRef: string
    kind: AlertKind // optional on old records: treat missing as "notable"
    status: "raised" | "acknowledged" | "investigating" | "escalated"
    escalateAt: number // ms; the SiteActor alarm escalates unacknowledged alerts at this time (raised + 30s)
    incId?: string // set when investigating/escalated
    history: { status: Alert["status"]; at: number }[]
}

export interface Claim {
    t: number
    text: string
    entityIds: string[]
    frameRef: string
    confidence: number // 0–1
}

export interface Testimony {
    camId: string
    claims: Claim[]
}

export interface Citation {
    camId: string
    t: number
    frameRef: string
}

export interface TimelineItem {
    id: string
    t: number
    claim: string
    entityIds: string[]
    citations: Citation[]
    confidence: number
    inferred: boolean
    revisedFrom?: string // previous claim text when a revision changed it
}

export interface Contradiction {
    id: string
    a: string // claim text from one camera
    b: string // conflicting claim from another
    cams: [string, string]
    resolution: string | null
}

export type RelayKind = "question" | "testimony" | "reexamine" | "answer" | "alert" | "knock" | "admit" | "verdict"

// One Relay message as the dashboard shows it.
export interface RelayCard {
    id: string
    kind: RelayKind
    from: string // agent name: "investigator", "cam-1", "site", "guest-7f3a"
    to: string // "#incident-1", "@cam-2", "#site"
    text: string // short human-readable summary for the card
    t: number // when it was sent (wall clock ms)
    threadOf?: string // id of the question card this answers
    incId?: string
}

export interface IncidentState {
    id: string // "inc-1"
    question: string
    window: [number, number]
    status: "gathering" | "analysing" | "done"
    witnesses: { camId: string; status: "asked" | "answered" | "silent" }[]
    timeline: TimelineItem[]
    contradictions: Contradiction[]
    paths: { entityId: string; desc: string; points: PathPoint[] }[]
    summary: string | null // one-paragraph verdict
    revision: number
    transcript: RelayCard[]
}

export interface Knock {
    guestId: string
    offer: string // "clip 14:03:00–14:03:30"
    status: "uploading" | "waiting" | "approved" | "denied" | "done"
    message: string | null // shown to the guest, e.g. "Your clip covered a 15-second gap…"
}

export interface SiteSnapshot {
    cameras: CameraMeta[]
    edges: SiteEdge[]
    blindSpots: BlindSpot[]
    entities: { id: string; desc: string }[]
    currentIncidentId: string | null // dashboard fetches GET /api/incident/:id
    knocks: Knock[]
    alerts: Alert[] // most recent first, max 20
}

// Answer from one camera to an operator question (POST /api/cameras/:id/ask).
export interface AskResult {
    camId: string
    question: string
    text: string // the camera's answer, first person ("I saw…")
    claims: Claim[] // cited moments from its memory
}

// A short video clip a camera phone uploaded from its rolling buffer (requested on alerts and new incidents).
export interface Clip {
    id: string // "clip-<camId>-<t0>"
    camId: string
    t0: number // site time, ms
    t1: number
    url: string // "/frames/<camId>/clip-<t0>.webm" (or .mp4 from iOS)
    mime: string // "video/webm" | "video/mp4"
    reason: string // "alert al-3" | "incident inc-4"
}

// Everything the dashboard receives over its one websocket (SiteActor "site").
export type DashEvent =
    | { type: "snapshot"; site: SiteSnapshot }
    | { type: "camera"; camera: CameraMeta } // added, moved, online/offline, observation count
    | { type: "observation"; camId: string; t: number; people: number; frameRef: string }
    | { type: "edge"; edge: SiteEdge; isNew: boolean }
    | { type: "blind-spot"; spot: BlindSpot }
    | { type: "layout-reset" }
    | { type: "alert"; alert: Alert } // raised AND every status change (same id): upsert by id
    | { type: "relay"; card: RelayCard }
    | { type: "knock"; knock: Knock }
    | { type: "incident"; incident: IncidentState; changed: string[] } // changed = timeline item ids in this revision
    | { type: "clip"; clip: Clip }

// HTTP API (src/server.ts). Phones go through the tunnel; the dashboard runs on localhost.
//   GET  /api/config                  → { publicUrl, epoch }   (epoch changes on every wipe)
//   GET  /api/time                    → { t }
//   POST /api/cameras                 → CameraMeta              (registers a new fixed camera)
//   POST /api/cameras/:id/move        { pos, facing } → CameraMeta
//   POST /api/ingest?cam=&t=          body: image/jpeg → { ok, clip?: { reason } }  (clip set = upload your video buffer now)
//   POST /api/clips?cam=&t0=&t1=&reason=   body: video/webm | video/mp4 → Clip   (also broadcasts { type: "clip" })
//   GET  /api/clips?t0=&t1=&cam=      → Clip[]   (overlapping the window; cam optional)
//   POST /api/socket/site             → { websocketUrl }        (Terse prepareWebsocket grant)
//   POST /api/site/wipe               → { ok }   (FULL reset incl. cameras + frames; phones must reload)
//   POST /api/site/reset              → { ok }   (keeps cameras + positions; clears edges, blind spots,
//                                                 entities, sightings, alerts, knocks, incidents)
//   POST /api/incident                { question?, t0?, t1?, alertId?, camIds?, fresh? } → { incId }
//                                     fresh: true = always a new incident (the "New incident" dialog); camIds limits witnesses
//   GET  /api/cameras/:id/recent?limit=  → Observation[]   (newest first, default 30; the camera's memory)
//   POST /api/cameras/:id/ask         { question } → AskResult  (operator asks one camera over Relay; also emits relay cards)
//   POST /api/alerts/:id/ack          → Alert   (cancels escalation)
//   GET  /api/incident/:id            → IncidentState
//   POST /api/witness                 → { guestId }
//   POST /api/witness/:id/frame?t=    body: image/jpeg → { ok }   (t = clip-relative ms + clip start estimate)
//   POST /api/witness/:id/done        { startedAt, durationMs } → { ok }  (aligns, then knocks)
//   GET  /api/witness/:id             → Knock
//   POST /api/knock/:guestId          { ok: boolean } → { ok }
//   GET  /frames/<camId>/<t>.jpg      stored keyframes (+ <t>.json sidecar: { people })
//   POST /api/debug/observe, GET /api/debug/paths   test-only (scripts/a-sim.ts)

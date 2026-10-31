import type { Alert, BlindSpot, CameraMeta, DashEvent, IncidentState, Knock, RelayCard, SiteEdge } from "../../shared/types"

export interface ObsInfo {
    t: number
    frameRef: string
    people: number
    n: number // observations seen this session
}

export interface FrameInfo {
    t: number
    frameRef: string
    people: number
}

export const THUMBS = 7 // latest + 6 thumbnails per camera

export interface DashState {
    hasSnapshot: boolean
    cameras: Record<string, CameraMeta>
    cameraOrder: string[]
    edges: Record<string, SiteEdge>
    blindSpots: BlindSpot[]
    entities: { id: string; desc: string }[]
    alerts: Alert[]
    alertToasts: string[] // alert ids currently shown as toasts
    knocks: Record<string, Knock>
    knockDismissed: string[]
    cards: RelayCard[]
    incident: IncidentState | null
    changed: { ids: string[]; rev: number }
    lastObs: Record<string, ObsInfo>
    frames: Record<string, FrameInfo[]> // newest last
    events: number
}

export const initialState: DashState = {
    hasSnapshot: false,
    cameras: {},
    cameraOrder: [],
    edges: {},
    blindSpots: [],
    entities: [],
    alerts: [],
    alertToasts: [],
    knocks: {},
    knockDismissed: [],
    cards: [],
    incident: null,
    changed: { ids: [], rev: 0 },
    lastObs: {},
    frames: {},
    events: 0
}

export type Action =
    | { type: "event"; event: DashEvent }
    | { type: "dismiss-alert"; id: string }
    | { type: "dismiss-knock"; guestId: string }
    | { type: "local-camera"; camera: CameraMeta }
    | { type: "clear" }

function mergeCards(existing: RelayCard[], incoming: RelayCard[]): RelayCard[] {
    if (incoming.length === 0) return existing
    const byId = new Map(existing.map(c => [c.id, c]))
    let changed = false
    for (const c of incoming) {
        const prev = byId.get(c.id)
        if (!prev || prev.text !== c.text || prev.threadOf !== c.threadOf) {
            byId.set(c.id, c)
            changed = true
        }
    }
    if (!changed) return existing
    return [...byId.values()].sort((a, b) => a.t - b.t)
}

// Old records may lack the newer alert fields.
function normAlert(a: Alert): Alert {
    return { ...a, kind: a.kind ?? "notable", status: a.status ?? "raised", escalateAt: a.escalateAt ?? a.t + 30000, history: a.history ?? [] }
}

function camOrder(order: string[], id: string): string[] {
    return order.includes(id) ? order : [...order, id]
}

function sortCamIds(ids: string[]): string[] {
    const num = (s: string) => {
        const m = /(\d+)$/.exec(s)
        return m ? Number(m[1]) : 999
    }
    return [...ids].sort((a, b) => {
        const ga = a.startsWith("guest") ? 1 : 0
        const gb = b.startsWith("guest") ? 1 : 0
        return ga - gb || num(a) - num(b) || a.localeCompare(b)
    })
}

function applyEvent(s: DashState, e: DashEvent): DashState {
    switch (e.type) {
        case "snapshot": {
            const site = e.site
            const cameras = Object.fromEntries(site.cameras.map(c => [c.id, c]))
            const keep = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => k in cameras))
            const cur = site.currentIncidentId
            return {
                ...s,
                hasSnapshot: true,
                cameras,
                cameraOrder: sortCamIds(site.cameras.map(c => c.id)),
                edges: Object.fromEntries(site.edges.map(x => [x.id, x])),
                blindSpots: site.blindSpots,
                entities: site.entities,
                alerts: site.alerts.map(normAlert),
                alertToasts: [
                    ...s.alertToasts.filter(id => site.alerts.some(a => a.id === id)),
                    ...site.alerts
                        .filter(a => (a.status ?? "raised") === "raised" && (a.escalateAt ?? 0) > Date.now() && !s.alertToasts.includes(a.id))
                        .map(a => a.id)
                ].slice(-4),
                knocks: Object.fromEntries(site.knocks.map(k => [k.guestId, k])),
                // Only the site's current incident is shown; anything else is stale.
                incident: cur && s.incident?.id === cur ? s.incident : null,
                cards: s.cards.filter(c => (c.incId ? c.incId === cur : true)),
                lastObs: keep(s.lastObs),
                frames: keep(s.frames)
            }
        }
        case "camera": {
            const prev = s.cameras[e.camera.id]
            return {
                ...s,
                cameras: { ...s.cameras, [e.camera.id]: { ...prev, ...e.camera } },
                cameraOrder: camOrder(s.cameraOrder, e.camera.id)
            }
        }
        case "observation": {
            const prev = s.lastObs[e.camId]
            const cam = s.cameras[e.camId]
            const hist = s.frames[e.camId] ?? []
            const frames = hist.some(f => f.frameRef === e.frameRef) ? hist : [...hist, { t: e.t, frameRef: e.frameRef, people: e.people }].slice(-THUMBS)
            return {
                ...s,
                frames: { ...s.frames, [e.camId]: frames },
                lastObs: { ...s.lastObs, [e.camId]: { t: e.t, frameRef: e.frameRef, people: e.people, n: (prev?.n ?? 0) + 1 } },
                cameras: cam ? { ...s.cameras, [e.camId]: { ...cam, online: true, observations: Math.max(cam.observations, (prev?.n ?? 0) + 1) } } : s.cameras
            }
        }
        case "edge":
            return { ...s, edges: { ...s.edges, [e.edge.id]: e.edge } }
        case "blind-spot": {
            const rest = s.blindSpots.filter(b => !(b.camId === e.spot.camId && b.edge === e.spot.edge))
            return { ...s, blindSpots: [...rest, e.spot] }
        }
        case "layout-reset":
            return {
                ...s,
                edges: {},
                blindSpots: [],
                entities: [],
                alerts: [],
                alertToasts: [],
                knocks: {},
                knockDismissed: [],
                cards: [],
                incident: null,
                changed: { ids: [], rev: s.changed.rev + 1 }
            }
        case "alert": {
            // Upsert by id: the same alert arrives again on every status change.
            const a = normAlert(e.alert)
            const exists = s.alerts.some(x => x.id === a.id)
            const alerts = exists ? s.alerts.map(x => (x.id === a.id ? a : x)) : [a, ...s.alerts].slice(0, 20)
            const shown = s.alertToasts.includes(a.id)
            const alertToasts = shown ? s.alertToasts : !exists && a.status === "raised" ? [...s.alertToasts, a.id].slice(-4) : s.alertToasts
            return { ...s, alerts, alertToasts }
        }
        case "relay":
            return { ...s, cards: mergeCards(s.cards, [e.card]) }
        case "knock":
            return { ...s, knocks: { ...s.knocks, [e.knock.guestId]: e.knock } }
        case "incident": {
            const inc = e.incident
            const isNew = !s.incident || s.incident.id !== inc.id
            // Ignore stale revisions arriving out of order.
            if (!isNew && s.incident && inc.revision < s.incident.revision) return s
            return {
                ...s,
                incident: inc,
                cards: mergeCards(s.cards, inc.transcript ?? []),
                changed: e.changed.length ? { ids: e.changed, rev: s.changed.rev + 1 } : isNew ? { ids: [], rev: s.changed.rev + 1 } : s.changed
            }
        }
    }
    return s
}

export function reducer(s: DashState, a: Action): DashState {
    switch (a.type) {
        case "event": {
            const next = applyEvent(s, a.event)
            return { ...next, events: s.events + 1 }
        }
        case "dismiss-alert":
            return { ...s, alertToasts: s.alertToasts.filter(id => id !== a.id) }
        case "dismiss-knock":
            return { ...s, knockDismissed: [...s.knockDismissed, a.guestId] }
        case "local-camera":
            return { ...s, cameras: { ...s.cameras, [a.camera.id]: a.camera } }
        case "clear":
            return initialState
    }
}

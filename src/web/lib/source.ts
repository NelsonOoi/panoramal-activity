import type { Alert, DashEvent, IncidentState } from "../../shared/types"
import { getJSON, postJSON } from "./api"

export type SourceStatus = "connecting" | "live" | "reconnecting" | "replay" | "replay-done" | "mock" | "error"

export interface Recorded {
    at: number // ms since recording start
    event: DashEvent
}

// Every event the dashboard receives is kept here so a live run can be saved and replayed later.
const recording: Recorded[] = []
let recordStart = 0
export function record(event: DashEvent) {
    const now = Date.now()
    if (!recordStart) recordStart = now
    recording.push({ at: now - recordStart, event })
}
export function recordingLength() {
    return recording.length
}
export function clearRecording() {
    recording.length = 0
    recordStart = 0
}
export function downloadRecording() {
    const body = recording.map(r => JSON.stringify(r)).join("\n") + "\n"
    const blob = new Blob([body], { type: "application/x-ndjson" })
    const a = document.createElement("a")
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
    a.href = URL.createObjectURL(blob)
    a.download = `run-${stamp}.jsonl`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function unwrap(raw: unknown): DashEvent | null {
    let v: any = raw
    if (typeof v === "string") {
        try {
            v = JSON.parse(v)
        } catch {
            return null
        }
    }
    if (v && typeof v === "object" && typeof v.type === "string") return v as DashEvent
    for (const k of ["data", "message", "payload", "event"]) {
        if (v && typeof v === "object" && v[k] && typeof v[k] === "object" && typeof v[k].type === "string") return v[k]
    }
    return null
}

export interface Source {
    stop(): void
}

// Live: POST /api/socket/site → websocket. Reconnects with backoff.
export function connectLive(emit: (e: DashEvent) => void, setStatus: (s: SourceStatus) => void): Source {
    let stopped = false
    let ws: WebSocket | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const deliver = (e: DashEvent) => {
        record(e)
        emit(e)
    }

    const schedule = () => {
        if (stopped) return
        setStatus("reconnecting")
        const delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250
        attempt++
        timer = setTimeout(open, delay)
    }

    async function open() {
        if (stopped) return
        try {
            const { websocketUrl } = await postJSON<{ websocketUrl: string }>("/api/socket/site")
            if (stopped) return
            ws = new WebSocket(websocketUrl)
            ws.onopen = () => {
                attempt = 0
                setStatus("live")
            }
            ws.onmessage = async msg => {
                const data = typeof msg.data === "string" ? msg.data : await (msg.data as Blob).text?.()
                const e = unwrap(data)
                if (!e) return
                deliver(e)
                if (e.type === "snapshot" && e.site.currentIncidentId) {
                    try {
                        const inc = await getJSON<IncidentState>(`/api/incident/${encodeURIComponent(e.site.currentIncidentId)}`)
                        deliver({ type: "incident", incident: inc, changed: [] })
                    } catch (err) {
                        console.warn("incident fetch failed", err)
                    }
                }
            }
            ws.onclose = () => {
                ws = null
                schedule()
            }
            ws.onerror = () => ws?.close()
        } catch (err) {
            console.warn("socket grant failed", err)
            schedule()
        }
    }

    setStatus("connecting")
    open()
    return {
        stop() {
            stopped = true
            if (timer) clearTimeout(timer)
            ws?.close()
        }
    }
}

export interface Player extends Source {
    pause(): void
    resume(): void
    restart(): void
    setSpeed(x: number): void
    progress(): { index: number; total: number; paused: boolean; speed: number }
}

// Plays a list of timed events with their original spacing.
export function playEvents(
    items: Recorded[],
    emit: (e: DashEvent) => void,
    onDone: () => void,
    onRestart: () => void,
    speed0 = 1
): Player {
    let index = 0
    let paused = false
    let speed = speed0
    let timer: ReturnType<typeof setTimeout> | null = null
    let clock = 0 // recording-time position
    let lastWall = 0

    const tick = () => {
        timer = null
        if (paused) return
        const now = performance.now()
        clock += (now - lastWall) * speed
        lastWall = now
        while (index < items.length && items[index].at <= clock) {
            emit(items[index].event)
            index++
        }
        if (index >= items.length) {
            onDone()
            return
        }
        const wait = Math.max(0, (items[index].at - clock) / speed)
        timer = setTimeout(tick, Math.min(wait, 1000))
    }
    const start = () => {
        lastWall = performance.now()
        tick()
    }
    start()
    return {
        stop() {
            if (timer) clearTimeout(timer)
            index = items.length
        },
        pause() {
            if (paused) return
            paused = true
            if (timer) clearTimeout(timer)
            timer = null
        },
        resume() {
            if (!paused) return
            paused = false
            start()
        },
        restart() {
            if (timer) clearTimeout(timer)
            index = 0
            clock = 0
            paused = false
            onRestart()
            start()
        },
        setSpeed(x: number) {
            speed = x
        },
        progress() {
            return { index, total: items.length, paused, speed }
        }
    }
}

export function parseRecording(text: string): Recorded[] {
    const out: Recorded[] = []
    let fallbackAt = 0
    for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            const v = JSON.parse(trimmed)
            if (v && typeof v.at === "number" && v.event) out.push({ at: v.at, event: v.event })
            else if (v && typeof v.type === "string") {
                out.push({ at: fallbackAt, event: v })
                fallbackAt += 600
            }
        } catch {
            /* skip bad line */
        }
    }
    out.sort((a, b) => a.at - b.at)
    // Start promptly: shift so the first event lands at 0.
    const first = out[0]?.at ?? 0
    return out.map(r => ({ ...r, at: r.at - first }))
}

// Recorded events carry their original site timestamps. Shift them to "now" so relative times read correctly.
export function rebaseTimes(items: Recorded[], wallStart: number): Recorded[] {
    const firstT = findFirstTime(items)
    if (firstT == null) return items
    const shift = wallStart - firstT
    return items.map(r => ({ ...r, event: shiftEvent(r.event, shift) }))
}

function findFirstTime(items: Recorded[]): number | null {
    for (const r of items) {
        const e = r.event
        if (e.type === "relay") return e.card.t - r.at
        if (e.type === "observation") return e.t - r.at
        if (e.type === "alert") return e.alert.t - r.at
    }
    return null
}

function shiftAlert(a: Alert, d: number): Alert {
    return { ...a, t: a.t + d, escalateAt: (a.escalateAt ?? a.t + 30000) + d, history: (a.history ?? []).map(h => ({ ...h, at: h.at + d })) }
}

function shiftEvent(e: DashEvent, d: number): DashEvent {
    switch (e.type) {
        case "relay":
            return { ...e, card: { ...e.card, t: e.card.t + d } }
        case "observation":
            return { ...e, t: e.t + d }
        case "alert":
            return { ...e, alert: shiftAlert(e.alert, d) }
        case "snapshot":
            return { ...e, site: { ...e.site, alerts: e.site.alerts.map(a => shiftAlert(a, d)) } }
        case "incident": {
            const i = e.incident
            return {
                ...e,
                incident: {
                    ...i,
                    window: [i.window[0] + d, i.window[1] + d],
                    timeline: i.timeline.map(x => ({ ...x, t: x.t + d, citations: x.citations.map(c => ({ ...c, t: c.t + d })) })),
                    paths: i.paths.map(p => ({ ...p, points: p.points.map(pt => ({ ...pt, t: pt.t + d })) })),
                    transcript: (i.transcript ?? []).map(c => ({ ...c, t: c.t + d }))
                }
            }
        }
        default:
            return e
    }
}

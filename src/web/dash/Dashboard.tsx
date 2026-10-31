import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { Alert, AskResult, DashEvent, IncidentState, Observation, RelayCard } from "../../shared/types"
import { action, getConfig, getJSON, isInert, setInert } from "../lib/api"
import { type Player, type Recorded, type SourceStatus, connectLive, parseRecording, playEvents, rebaseTimes } from "../lib/source"
import { initialState, reducer } from "../lib/store"
import { clock } from "../lib/format"
import { buildMock } from "../mock"
import { CameraView, type CameraApi } from "./CameraView"
import { CamerasCard } from "./Cameras"
import { CaseFile } from "./CaseFile"
import { Ctx, type FrameAt } from "./ctx"
import { DevPanel } from "./DevPanel"
import { loadSidecar } from "./frame"
import { Header } from "./Header"
import { NewIncident, type NewIncidentReq } from "./NewIncident"
import { RelayCardView } from "./Relay"
import { Toasts } from "./Toasts"

const params = new URLSearchParams(location.search)
const replayUrl = params.get("replay")
const mode: "live" | "mock" | "replay" = replayUrl ? "replay" : params.get("mock") ? "mock" : "live"
const speed = Number(params.get("speed") ?? 1) || 1

// Mock/replay: the camera view has no back end, so its memory is the observations this page has seen.
const localMemory: Record<string, { t: number; frameRef: string }[]> = {}
function remember(e: DashEvent) {
    if (e.type !== "observation") return
    const list = (localMemory[e.camId] ??= [])
    if (!list.some(o => o.frameRef === e.frameRef && o.t === e.t)) list.push({ t: e.t, frameRef: e.frameRef })
    if (list.length > 200) list.shift()
}
async function localRecent(camId: string): Promise<Observation[]> {
    const list = [...(localMemory[camId] ?? [])].sort((a, b) => b.t - a.t).slice(0, 60)
    return Promise.all(list.map(async o => ({ camId, t: o.t, frameRef: o.frameRef, people: (await loadSidecar(o.frameRef)) ?? [], objects: [], notable: null })))
}

export function Dashboard() {
    const [state, dispatch] = useReducer(reducer, initialState)
    const [status, setStatus] = useState<SourceStatus>(mode === "live" ? "connecting" : mode)
    const [player, setPlayer] = useState<Player | null>(null)
    const [publicUrl, setPublicUrl] = useState(location.origin)
    const [view, setView] = useState<{ camId: string; at?: FrameAt } | null>(null)
    const [newOpen, setNewOpen] = useState(false)
    const [dev, setDev] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        getConfig().then(c => setPublicUrl(c.publicUrl))
    }, [])

    const emit = useCallback((event: DashEvent) => {
        remember(event)
        dispatch({ type: "event", event })
    }, [])

    useEffect(() => {
        if (mode === "live") {
            const s = connectLive(emit, setStatus)
            return () => s.stop()
        }
        setInert(true)
        let p: Player | null = null
        let cancelled = false
        ;(async () => {
            let items: Recorded[]
            if (mode === "mock") items = buildMock(Date.now())
            else {
                const r = await fetch(replayUrl!)
                if (!r.ok) throw new Error(`replay ${replayUrl} → ${r.status}`)
                items = rebaseTimes(parseRecording(await r.text()), Date.now())
            }
            if (cancelled) return
            const played = playEvents(items, emit, () => setStatus(mode === "mock" ? "mock" : "replay-done"), () => {}, speed)
            p = { ...played, restart: () => location.reload() }
            setPlayer(p)
        })().catch(e => {
            console.error(e)
            setStatus("error")
        })
        return () => {
            cancelled = true
            p?.stop()
        }
    }, [emit])

    // Switch the case file to a just-opened incident without waiting for the socket.
    const follow = useCallback(async (incId: string | undefined) => {
        if (!incId) return
        try {
            const incident = await getJSON<IncidentState>(`/api/incident/${encodeURIComponent(incId)}`)
            dispatch({ type: "event", event: { type: "incident", incident, changed: [] } })
        } catch {
            /* the socket will deliver it */
        }
    }, [])

    const quick = useCallback(async () => {
        setBusy(true)
        setTimeout(() => setBusy(false), 1500)
        const r = await action<{ incId: string }>("/api/incident", {})
        follow(r?.incId)
    }, [follow])

    const startIncident = useCallback(
        async (req: NewIncidentReq) => {
            setNewOpen(false)
            const r = await action<{ incId: string }>("/api/incident", { ...req, fresh: true })
            follow(r?.incId)
        },
        [follow]
    )

    const onAck = useCallback((a: Alert) => {
        action<Alert>(`/api/alerts/${encodeURIComponent(a.id)}/ack`).then(res => {
            if (res && (res as Alert).id) dispatch({ type: "event", event: { type: "alert", alert: res } })
        })
    }, [])
    const onInvestigate = useCallback(
        (a: Alert) => {
            action<{ incId: string }>("/api/incident", { alertId: a.id }).then(r => follow(r?.incId))
        },
        [follow]
    )
    const onDismissAlert = useCallback((id: string) => dispatch({ type: "dismiss-alert", id }), [])
    const onKnock = useCallback((guestId: string, ok: boolean) => {
        action(`/api/knock/${encodeURIComponent(guestId)}`, { ok })
    }, [])
    const onDismissKnock = useCallback((guestId: string) => dispatch({ type: "dismiss-knock", guestId }), [])

    // Camera view back end: live HTTP, or local memory with a canned answer when inert.
    const camApi = useMemo<CameraApi>(
        () => ({
            recent: camId => (isInert() ? localRecent(camId) : getJSON<Observation[]>(`/api/cameras/${encodeURIComponent(camId)}/recent?limit=60`)),
            ask: async (camId, question) => {
                if (!isInert()) {
                    const r = await fetch(`/api/cameras/${encodeURIComponent(camId)}/ask`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ question })
                    })
                    if (!r.ok) {
                        const body = await r.json().catch(() => ({}))
                        throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`)
                    }
                    return (await r.json()) as AskResult
                }
                return localAsk(camId, question, emit)
            }
        }),
        [emit]
    )

    // Hidden keys: i = investigate the last minute, Shift+R = reset site, d = dev panel.
    const quickRef = useRef(quick)
    quickRef.current = quick
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
            if (e.metaKey || e.ctrlKey || e.altKey) return
            if (document.querySelector("[role=dialog]")) return
            if (e.key === "i") quickRef.current()
            else if (e.key === "d") setDev(v => !v)
            else if (e.key === "R" && e.shiftKey) {
                if (confirm("Reset the site? Cameras are kept; handoffs, blind spots, alerts and incidents are cleared.")) action("/api/site/reset")
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [])

    const openCamera = useCallback((camId: string, at?: FrameAt) => setView({ camId, at }), [])
    const ctx = useMemo(() => ({ cameras: state.cameras, openCamera }), [state.cameras, openCamera])
    const cams = Object.values(state.cameras)
    const alertToasts = state.alertToasts.map(id => state.alerts.find(a => a.id === id)).filter((a): a is Alert => !!a)
    const knocks = Object.values(state.knocks).filter(k => !state.knockDismissed.includes(k.guestId) && k.status !== "done")
    const closeView = useCallback(() => setView(null), [])
    const viewCam = view ? (state.cameras[view.camId] ?? null) : null
    const camIds = cams.map(c => c.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    return (
        <Ctx.Provider value={ctx}>
            <div className="flex min-h-dvh flex-col min-[1340px]:h-dvh">
                <Header status={status} cameras={cams.length} online={cams.filter(c => c.online).length} busy={busy} onNew={() => setNewOpen(true)} onQuick={quick} />
                <main className="flex min-h-0 flex-1 flex-wrap items-stretch gap-4 px-5 py-4">
                    <CamerasCard state={state} publicUrl={publicUrl} className="flex-[999_1_560px] min-[1340px]:h-full" />
                    <RelayCardView cards={state.cards} incident={state.incident} className="max-h-[80vh] flex-[1_1_320px] min-[1340px]:h-full min-[1340px]:max-h-none" />
                    <CaseFile incident={state.incident} className="max-h-[80vh] flex-[1_1_380px] min-[1340px]:h-full min-[1340px]:max-h-none" />
                </main>
            </div>
            <Toasts
                alerts={alertToasts}
                knocks={knocks}
                onAck={onAck}
                onInvestigate={onInvestigate}
                onDismissAlert={onDismissAlert}
                onKnock={onKnock}
                onDismissKnock={onDismissKnock}
            />
            <CameraView camera={viewCam} at={view?.at} lastN={view ? (state.lastObs[view.camId]?.n ?? 0) : 0} api={camApi} onClose={closeView} />
            <NewIncident open={newOpen} camIds={camIds} onClose={() => setNewOpen(false)} onStart={startIncident} />
            {dev && <DevPanel status={status} events={state.events} player={player} mode={mode} />}
        </Ctx.Provider>
    )
}

// Mock/replay answer: built from what this page has seen, with the operator's Relay exchange.
let localSeq = 0
async function localAsk(camId: string, question: string, emit: (e: DashEvent) => void): Promise<AskResult> {
    const now = Date.now()
    const qCard: RelayCard = { id: `op-q-${++localSeq}`, kind: "question", from: "operator", to: `@${camId}`, text: question, t: now }
    emit({ type: "relay", card: qCard })
    await new Promise(r => setTimeout(r, 1600))
    const obs = await localRecent(camId)
    const seen = obs.filter(o => o.people.length)
    const who = new Map<string, { desc: string; t: number; frameRef: string }>()
    for (const o of [...seen].reverse()) for (const p of o.people) if (!who.has(p.id)) who.set(p.id, { desc: p.desc, t: o.t, frameRef: o.frameRef })
    const text = who.size
        ? `I saw ${[...who.entries()].map(([id, w]) => `${id} (${w.desc}) at ${clock(w.t)}`).join(", ")}. I have ${obs.length} frames in memory.`
        : obs.length
          ? `Nobody came into my view in the ${obs.length} frames I remember.`
          : "I haven't recorded anything yet."
    const claims = [...who.entries()].slice(0, 3).map(([id, w]) => ({ t: w.t, text: `${id} in view`, entityIds: [id], frameRef: w.frameRef, confidence: 0.9 }))
    if (!claims.length && obs[0]) claims.push({ t: obs[0].t, text: "latest frame", entityIds: [], frameRef: obs[0].frameRef, confidence: 0.9 })
    emit({ type: "relay", card: { id: `op-a-${localSeq}`, kind: "answer", from: camId, to: "@operator", text, t: Date.now(), threadOf: qCard.id } })
    return { camId, question, text, claims }
}


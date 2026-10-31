// App server: Express API + Vite middleware on :3000. Owner: track A.
import express from "express"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"

import { actors } from "../generated/index.js"
import { edgeOf } from "./actors/camera.js"
import { alignOffset } from "./align.js"
import { publish } from "./publish.js"
import * as relay from "./relay.js"
import { admitWitness, ensureCameraAgent, postAlert, runInvestigation, sendKnock, startRelay } from "./relay.js"
import type { Alert, AlertKind, AskResult, CameraMeta, Knock, Observation, Sighting, VisionResult } from "./shared/types.js"
import { describeFrame } from "./vision.js"

const PORT = Number(process.env.PORT ?? 3000)
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`
const AUTO_INVESTIGATE = process.env.AUTO_INVESTIGATE === "1"

// The actor host restarts on every actor source change (hot reload): retry "unavailable" for up to ~8s.
function retrying<T extends object>(stub: T): T {
    const target = stub as any // stubs are frozen, so proxy an empty object and forward
    return new Proxy({} as T, {
        get(_, prop) {
            const v = target[prop]
            if (typeof v !== "function") return v
            return async (...args: unknown[]) => {
                for (let i = 0; ; i++) {
                    try {
                        return await v.apply(target, args)
                    } catch (err) {
                        if (i < 16 && (err as { code?: string })?.code === "unavailable") {
                            await new Promise(r => setTimeout(r, 500))
                            continue
                        }
                        throw err
                    }
                }
            }
        }
    })
}
const site = () => retrying(actors.SiteActor.get("site"))
const cam = (id: string) => retrying(actors.CameraActor.get(id))

const bg = (label: string, p: Promise<unknown>) => p.catch(err => console.error(`[${label}]`, err instanceof Error ? err.message : err))

// ---------- ingest pipeline (per-camera serialized queue) ----------

const queues = new Map<string, { chain: Promise<void>; pending: number }>()

function enqueue(camId: string, job: () => Promise<void>): boolean {
    const q = queues.get(camId) ?? { chain: Promise.resolve(), pending: 0 }
    queues.set(camId, q)
    if (q.pending > 2) return false
    q.pending++
    q.chain = q.chain.then(job).catch(err => console.error(`[ingest ${camId}]`, err)).finally(() => { q.pending-- })
    return true
}

// Camera ids the site knows; frames from unknown (e.g. pre-wipe) cameras get a 404 so phones re-register.
const knownCams = new Set<string>()
async function refreshKnownCams() {
    knownCams.clear()
    for (const c of await site().listCameras()) knownCams.add(c.id)
}

async function isKnownCam(id: string): Promise<boolean> {
    if (knownCams.has(id)) return true
    await refreshKnownCams() // cache miss (e.g. right after boot): ask the site
    return knownCams.has(id)
}

// Last vision result per camera (entity ids already resolved), reused for heartbeat frames.
const lastVision = new Map<string, VisionResult>()

const drain = (camId: string) => queues.get(camId)?.chain ?? Promise.resolve()

async function saveFrame(camId: string, t: number, jpeg: Buffer): Promise<string> {
    await mkdir(`frames/${camId}`, { recursive: true })
    await writeFile(`frames/${camId}/${t}.jpg`, jpeg)
    return `/frames/${camId}/${t}.jpg`
}

// Everything after vision: entity ids, camera memory, layout learning, sightings, alerts.
type FrameOpts = { guest: boolean; heartbeat?: boolean; tamper?: "covered" }

const TAMPER_TEXT = { covered: "Camera covered or blurred" } as const

// Stores one alert (debounced per camera per kind), tells Relay, optionally auto-investigates.
async function raiseAlert(input: { camId: string; t: number; text: string; frameRef: string; kind: AlertKind }) {
    const alert = await site().createAlert(input) // the actor broadcasts { type: "alert" }
    if (!alert) return
    console.log(`[alert ${alert.id}] ${alert.kind} on ${alert.camId}: "${alert.text}" (escalates in 30s)`)
    bg("postAlert", postAlert(alert))
    if (AUTO_INVESTIGATE) bg("auto-incident", openIncident({ alertId: alert.id }))
}

async function processVision(camId: string, t: number, frameRef: string, vision: VisionResult, opts: FrameOpts) {
    const s = site()
    const people = await s.resolveEntities(vision.people)
    const obs: Observation = { camId, t, frameRef, people, objects: vision.objects, notable: vision.notable }
    lastVision.set(camId, { people, objects: vision.objects, notable: null })
    // Sidecar for the dashboard's frame dialog, which draws these boxes over the keyframe.
    const sidecar = `.${frameRef.replace(/\.jpg$/, ".json")}`
    bg("frame-sidecar", mkdir(sidecar.slice(0, sidecar.lastIndexOf("/")), { recursive: true }).then(() => writeFile(sidecar, JSON.stringify({ people }))))
    const { camera, entries, exits, alerts, warmingUp } = await cam(camId).ingest(obs, { heartbeat: !!opts.heartbeat })
    if (!opts.guest) {
        for (const e of exits) await s.recordExit(e)
        for (const e of entries) await s.recordEntry(e)
    }
    const sightings: Sighting[] = people.map(p => ({ entityId: p.id, camId, t, edge: edgeOf(p), desc: p.desc, action: p.action, frameRef }))
    await s.addSightings(sightings)
    await s.putCamera(camera) // broadcasts { type: "camera" }
    await publish({ type: "observation", camId, t, people: people.length, frameRef })

    if (!opts.guest && !warmingUp) {
        if (opts.tamper) await raiseAlert({ camId, t, text: TAMPER_TEXT[opts.tamper], frameRef, kind: "tamper" })
        for (const a of alerts) await raiseAlert({ camId, t, text: a.text, frameRef, kind: a.kind })
        if (obs.notable) await raiseAlert({ camId, t, text: obs.notable, frameRef, kind: "notable" })
    }
}

async function processFrame(camId: string, t: number, frameRef: string, jpeg: Buffer, opts: FrameOpts) {
    const prev = opts.heartbeat ? lastVision.get(camId) : undefined
    if (prev) return processVision(camId, t, frameRef, prev, opts) // static scene: skip the LLM, keep everyone visible
    const known = await site().recentEntities(120_000, 10)
    const labels = await cam(camId).trackedLabels().catch(() => [] as string[])
    const vision = await describeFrame(camId, jpeg, known, labels)
    await processVision(camId, t, frameRef, vision, opts)
}

// ---------- incidents ----------

async function openIncident(body: {
    question?: string; t0?: number; t1?: number; alertId?: string; camIds?: string[]; fresh?: boolean; escalated?: boolean
}): Promise<{ incId: string; isNew: boolean }> {
    const s = site()
    let question = body.question?.trim() || "What happened?"
    let window: [number, number]
    const alert: Alert | null = body.alertId ? await s.getAlert(body.alertId) : null
    if (body.alertId && !alert) throw new Error(`unknown alert ${body.alertId}`)
    if (alert) {
        window = [alert.t - 30_000, alert.t + 15_000]
        if (!body.question?.trim()) question = `What happened around "${alert.text}"?`
    } else {
        const now = Date.now()
        window = [body.t0 ?? now - 60_000, body.t1 ?? now]
    }
    let { incId, isNew } = await s.openIncident(window, { fresh: !!body.fresh })
    // A brand-new id whose IncidentActor already holds a case (pre-wipe leftovers): skip to the next id.
    for (let i = 0; isNew && i < 100 && (await retrying(actors.IncidentActor.get(incId)).get()); i++) {
        await s.dropIncident(incId)
        ;({ incId, isNew } = await s.openIncident(window, { fresh: true }))
    }
    // Also (re)open when the site has the id but the case file was never created (e.g. a failed earlier open).
    if (isNew || !(await retrying(actors.IncidentActor.get(incId)).get())) {
        const only = Array.isArray(body.camIds) && body.camIds.length ? new Set(body.camIds.map(String)) : null
        // Witnesses: fixed cameras by default; with camIds, exactly those (admitted ones only, guests included if admitted).
        const cams = (await s.listCameras()).filter(c => (only ? only.has(c.id) && c.admitted : c.kind === "fixed"))
        const camIds: string[] = []
        for (const c of cams) {
            if (c.online || (await cam(c.id).recall(window[0], window[1])).length > 0) camIds.push(c.id)
        }
        const incident = await retrying(actors.IncidentActor.get(incId)).open(question, window, camIds)
        await publish({ type: "incident", incident, changed: [] })
        bg("runInvestigation", runInvestigation(incId))
    }
    // Investigating (or escalated) cancels the alert's escalation and links the case.
    if (alert) await s.updateAlert(alert.id, body.escalated ? "escalated" : "investigating", incId)
    // Any other raised alert inside this window belongs to the same case: stop its countdown too.
    const claimed = await s.claimAlerts(window, incId)
    if (claimed.length) console.log(`[incident ${incId}] claimed alerts ${claimed.map(a => a.id).join(", ")}`)
    return { incId, isNew }
}

// An alert nobody acknowledged within 30s: open its incident and notify Relay.
async function handleEscalation(alert: Alert, by: "alarm" | "tick") {
    console.log(`[alert ${alert.id}] ESCALATED by ${by === "alarm" ? "SiteActor alarm" : "server tick (backstop)"}: "${alert.text}"`)
    // No fresh: an overlapping open incident (e.g. one opened for a sibling alert) absorbs it.
    const { incId, isNew } = await openIncident({ alertId: alert.id, escalated: true })
    console.log(`[alert ${alert.id}] escalated → incident ${incId}${isNew ? " (new)" : " (existing)"}`)
    bg("postAlert", postAlert({ ...alert, incId, text: `ESCALATED: no response in 30s. ${alert.text}` }))
}

// ---------- app ----------

const app = express()
const server = createHttpServer(app)
const json = express.json({ limit: "2mb" })
const jpegBody = express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "5mb" })

const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => (req: express.Request, res: express.Response) => {
    fn(req, res).catch(err => {
        console.error(`[${req.method} ${req.path}]`, err)
        if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    })
}

app.get("/api/config", route(async (_req, res) => {
    res.set("Cache-Control", "no-store").json({ publicUrl: PUBLIC_URL, epoch: await site().getEpoch() })
}))
app.get("/api/time", (_req, res) => { res.set("Cache-Control", "no-store").json({ t: Date.now() }) })

app.post("/api/cameras", route(async (_req, res) => {
    const meta = await site().addCamera("fixed")
    knownCams.add(meta.id)
    await cam(meta.id).init(meta)
    bg("ensureCameraAgent", ensureCameraAgent(meta.id))
    res.json(meta)
}))

app.get("/api/cameras", route(async (_req, res) => { res.json(await site().listCameras()) }))

app.post("/api/cameras/:id/move", json, route(async (req, res) => {
    const id = String(req.params.id)
    const patch: Partial<CameraMeta> = {}
    if (req.body?.pos) patch.pos = { x: Number(req.body.pos.x), y: Number(req.body.pos.y) }
    if (req.body?.facing !== undefined) patch.facing = Number(req.body.facing)
    const meta = await cam(id).update(patch)
    await site().putCamera(meta)
    res.json(meta)
}))

app.get("/api/cameras/:id/recent", route(async (req, res) => {
    const id = String(req.params.id)
    if (!(await isKnownCam(id))) return res.status(404).json({ error: "unknown camera" })
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 30))
    const now = Date.now()
    const obs = await cam(id).recall(0, now + 60 * 60_000) // the actor keeps ~10 min; offset applied
    res.json(obs.sort((a, b) => b.t - a.t).slice(0, limit))
}))

app.post("/api/cameras/:id/ask", json, route(async (req, res) => {
    const id = String(req.params.id)
    const question = String(req.body?.question ?? "").trim()
    if (!question) return res.status(400).json({ error: "need question" })
    if (!(await isKnownCam(id))) return res.status(404).json({ error: "unknown camera" })
    const askCamera = (relay as Record<string, unknown>).askCamera as ((camId: string, q: string) => Promise<AskResult>) | undefined
    if (typeof askCamera !== "function") return res.status(503).json({ error: "ask not ready" })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">(r => { timer = setTimeout(() => r("timeout"), 30_000) })
    const result = await Promise.race([askCamera(id, question), timeout]).finally(() => clearTimeout(timer))
    if (result === "timeout") return res.status(504).json({ error: "camera did not answer within 30s" })
    res.json(result)
}))

app.post("/api/ingest", jpegBody, route(async (req, res) => {
    const camId = String(req.query.cam ?? "")
    const t = Number(req.query.t) || Date.now()
    const jpeg = req.body as Buffer
    if (!camId || !Buffer.isBuffer(jpeg) || !jpeg.length) return res.status(400).json({ error: "need ?cam= and a JPEG body" })
    if (!(await isKnownCam(camId))) return res.status(404).json({ error: "unknown camera", camId })
    const q = queues.get(camId)
    if (q && q.pending > 2) return res.json({ ok: true, dropped: true })
    const frameRef = await saveFrame(camId, t, jpeg)
    res.json({ ok: true })
    const heartbeat = req.query.hb === "1"
    const tamper = req.query.tamper === "covered" ? "covered" : undefined // "moved" was removed (too noisy)
    enqueue(camId, () => processFrame(camId, t, frameRef, jpeg, { guest: false, heartbeat, tamper }))
}))

// Dev/test hook: run the pipeline with a synthetic vision result (no image, no LLM).
app.post("/api/debug/observe", json, route(async (req, res) => {
    const { cam: camId, t = Date.now(), people = [], objects = [], notable = null, guest = false, heartbeat = false, tamper } = req.body ?? {}
    if (!camId) return res.status(400).json({ error: "need cam" })
    const frameRef = `/frames/${camId}/${t}.jpg`
    const opts: FrameOpts = { guest, heartbeat, tamper: tamper === "covered" ? "covered" : undefined }
    await new Promise<void>(resolve => {
        const job = () => processVision(camId, t, frameRef, { people, objects, notable }, opts)
        if (!enqueue(camId, () => job().finally(resolve))) resolve()
    })
    res.json({ ok: true })
}))

app.get("/api/debug/paths", route(async (req, res) => {
    const t1 = Number(req.query.t1) || Date.now()
    const t0 = Number(req.query.t0) || t1 - 10 * 60_000
    res.json(await site().paths(t0, t1))
}))

app.post("/api/socket/site", route(async (_req, res) => {
    const grant = await actors.SiteActor.prepareWebsocket({ actorId: "site", metadata: { role: "dashboard" } })
    res.set("Cache-Control", "no-store").json(grant)
}))

app.post("/api/site/reset", route(async (_req, res) => {
    const s = site()
    await s.resetLayout()
    await publish({ type: "layout-reset" })
    await publish({ type: "snapshot", site: await s.snapshot() })
    res.json({ ok: true })
}))

// FULL demo reset: forgets cameras too, resets counters (next camera cam-1, first entity A), deletes stored frames.
app.post("/api/site/wipe", route(async (_req, res) => {
    const s = site()
    await s.wipe()
    knownCams.clear()
    lastVision.clear()
    queues.clear()
    await rm("frames", { recursive: true, force: true })
    await mkdir("frames", { recursive: true })
    await publish({ type: "layout-reset" })
    await publish({ type: "snapshot", site: await s.snapshot() })
    console.log("[server] site wiped")
    res.json({ ok: true })
}))

app.post("/api/alerts/:id/ack", route(async (req, res) => {
    const alert = await site().updateAlert(String(req.params.id), "acknowledged") // cancels escalation; broadcasts
    if (!alert) return res.status(404).json({ error: "no such alert" })
    res.json(alert)
}))

app.post("/api/incident", json, route(async (req, res) => {
    const { incId } = await openIncident(req.body ?? {})
    res.json({ incId })
}))

app.get("/api/incident/:id", route(async (req, res) => {
    const state = await actors.IncidentActor.get(String(req.params.id)).get()
    if (!state) return res.status(404).json({ error: "no such incident" })
    res.json(state)
}))

// ---------- guest witness ----------

app.post("/api/witness", route(async (_req, res) => {
    const s = site()
    const meta = await s.addCamera("upload")
    knownCams.add(meta.id)
    await cam(meta.id).init(meta)
    await s.putKnock({ guestId: meta.id, offer: "", status: "uploading", message: null })
    bg("ensureCameraAgent", ensureCameraAgent(meta.id))
    res.json({ guestId: meta.id })
}))

app.post("/api/witness/:id/frame", jpegBody, route(async (req, res) => {
    const camId = String(req.params.id)
    const t = Number(req.query.t) || Date.now()
    const jpeg = req.body as Buffer
    if (!Buffer.isBuffer(jpeg) || !jpeg.length) return res.status(400).json({ error: "need a JPEG body" })
    if (!(await isKnownCam(camId))) return res.status(404).json({ error: "unknown witness", camId })
    const frameRef = await saveFrame(camId, t, jpeg)
    res.json({ ok: true })
    // Uploads are not real-time: never drop, just queue.
    const q = queues.get(camId) ?? { chain: Promise.resolve(), pending: 0 }
    queues.set(camId, q)
    q.pending++
    q.chain = q.chain
        .then(() => processFrame(camId, t, frameRef, jpeg, { guest: true }))
        .catch(err => console.error(`[witness ${camId}]`, err))
        .finally(() => { q.pending-- })
}))

const hhmmss = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false })

app.post("/api/witness/:id/done", json, route(async (req, res) => {
    const guestId = String(req.params.id)
    const startedAt = Number(req.body?.startedAt) || Date.now()
    const durationMs = Number(req.body?.durationMs) || 0
    res.json({ ok: true })
    await drain(guestId)
    const { offsetMs, offsetErrMs, matched } = await alignOffset(guestId)
    console.log(`[witness ${guestId}] aligned offset=${offsetMs}ms ±${offsetErrMs}${matched ? ` via "${matched}"` : " (no match)"}`)
    const meta = await cam(guestId).update({ offsetMs, offsetErrMs })
    await site().putCamera(meta)
    const offer = `clip ${hhmmss(startedAt + offsetMs)}–${hhmmss(startedAt + offsetMs + durationMs)}`
    const knock: Knock = { guestId, offer, status: "waiting", message: null }
    await site().putKnock(knock)
    await publish({ type: "knock", knock })
    bg("sendKnock", sendKnock(guestId, offer))
}))

app.get("/api/witness/:id", route(async (req, res) => {
    const knock = await site().getKnock(String(req.params.id))
    if (!knock) return res.status(404).json({ error: "no such witness" })
    res.json(knock)
}))

app.post("/api/knock/:guestId", json, route(async (req, res) => {
    const guestId = String(req.params.guestId)
    const ok = !!req.body?.ok
    const s = site()
    const prev = await s.getKnock(guestId)
    if (!prev) return res.status(404).json({ error: "no such knock" })
    if (prev.status === "approved" || prev.status === "denied" || prev.status === "done") return res.json({ ok: true, status: prev.status })
    const knock = await s.putKnock({ ...prev, status: ok ? "approved" : "denied", message: ok ? null : "The site declined this footage. Thanks anyway." })
    const meta = await cam(guestId).update({ admitted: ok })
    await s.putCamera(meta)
    await publish({ type: "knock", knock })
    res.json({ ok: true })
    const incId = (await s.snapshot()).currentIncidentId
    if (ok && incId) bg("admitWitness", admitWitness(guestId, incId))
}))

// Stored keyframes.
app.use("/frames", express.static("frames", { maxAge: "1h", fallthrough: false }))
app.use("/api", (_req, res) => { res.status(404).json({ error: "not found" }) })

// ---------- front end (Vite middleware) ----------

try {
    const { createServer } = await import("vite")
    const vite = await createServer({
        server: { middlewareMode: true, ws: { server }, fs: { deny: [".env", ".env.*", "**/.durable-actors/**", "**/.git/**"] } },
        appType: "spa"
    })
    app.use(vite.middlewares)
    if (!existsSync("index.html")) console.warn("[server] index.html not found yet (track B) — only /api works")
} catch (err) {
    console.error("[server] Vite failed to start; API only:", err)
}

server.listen(PORT, "127.0.0.1", () => console.log(`[server] http://127.0.0.1:${PORT} (public ${PUBLIC_URL})`))

// ---------- boot ----------

// Backstop for actor alarms (lost when the actor host hot-reloads): expire pending exits, mark silent cameras offline.
let ticking = false
setInterval(async () => {
    if (ticking) return
    ticking = true
    try {
        const s = actors.SiteActor.get("site")
        for (const e of await s.tick()) bg("escalation", handleEscalation(e.alert, e.by))
        for (const c of await s.listCameras()) if (c.online) await actors.CameraActor.get(c.id).checkHeartbeat()
    } catch {
        // actor host restarting; try again next tick
    } finally {
        ticking = false
    }
}, 2000)

;(async () => {
    try {
        await startRelay()
        console.log("[relay] started")
    } catch (err) {
        console.error("[relay] startRelay failed (continuing without Relay):", err)
    }
    try {
        await refreshKnownCams()
        for (const id of knownCams) bg("ensureCameraAgent", ensureCameraAgent(id))
    } catch (err) {
        console.error("[boot] listing cameras failed:", err)
    }
})()

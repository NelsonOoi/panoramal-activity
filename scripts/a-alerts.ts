// Track A: big-change alerts + escalation, through the real server pipeline (POST /api/debug/observe). WIPES the site.
// Usage: bun scripts/a-alerts.ts   (server on :3000). Takes ~45s (waits for the 30s escalation).
import { actors } from "../generated/index.js"
import { buildPrompt } from "../src/vision.js"
import type { Alert } from "../src/shared/types.js"

const BASE = "http://127.0.0.1:3000"
const post = async (path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    return res.json() as Promise<any>
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const T0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)

await post("/api/site/wipe")
const cam = (await post("/api/cameras")).id as string
const { websocketUrl } = await post("/api/socket/site")
const ws = new WebSocket(websocketUrl)
const alerts = new Map<string, Alert>() // upsert by id
ws.onmessage = e => {
    const ev = JSON.parse(String(e.data))
    if (ev.type !== "alert") return
    const a = ev.alert as Alert
    if (alerts.get(a.id)?.status !== a.status) log(`ALERT ${a.id} ${a.kind} "${a.text}" → ${a.status}${a.incId ? ` (${a.incId})` : ""}`)
    alerts.set(a.id, a)
}
await new Promise(r => (ws.onopen = r))
log("camera", cam)

const person = (id: string, x: number, y = 0.4) => ({ id, desc: `person ${id}`, x, y, w: 0.08, h: 0.3, action: "standing" })
const tote = { label: "yellow tote", x: 0.5, y: 0.62 }
const table = { label: "table", x: 0.52, y: 0.7 }
const frame = (people: any[], objects: any[], extra: Record<string, unknown> = {}) =>
    post("/api/debug/observe", { cam, t: Date.now(), people, objects, notable: null, ...extra }).then(() => sleep(400))

// object-gone: tote on the table for 4 frames, then gone for 3 (+ a model "notable" in the same window: separate kinds)
await frame([person("new", 0.1)], [tote, table])
for (let i = 0; i < 3; i++) await frame([person("A", 0.1)], [tote, table])
await frame([person("A", 0.45)], [table], { notable: "person A picks up the yellow tote" })
await frame([person("A", 0.45)], [table])
await frame([person("A", 0.45)], [table]) // 3rd frame without the tote → object-gone
await frame([person("A", 0.45)], [table])
// crowd (+4) and object-left (backpack far from everyone, 3 frames)
const crowd = [person("A", 0.05), person("new", 0.12), person("new", 0.19), person("new", 0.26), person("new", 0.33)]
await frame(crowd, [table, { label: "backpack", x: 0.9, y: 0.9 }])
const crowd2 = crowd.map((p, i) => ({ ...p, id: "ABCDE"[i] }))
await frame(crowd2, [table, { label: "backpack", x: 0.9, y: 0.9 }])
await frame(crowd2, [table, { label: "backpack", x: 0.9, y: 0.9 }])
// tamper (phone sends &tamper=covered; same path via the debug hook)
await frame(crowd2, [table, { label: "backpack", x: 0.9, y: 0.9 }], { tamper: "covered", heartbeat: true })
await sleep(800)

const byKind = (k: string) => [...alerts.values()].filter(a => a.kind === k)
// Acknowledge everything except object-gone, which must escalate on its own.
for (const a of alerts.values()) if (a.kind !== "object-gone") await post(`/api/alerts/${a.id}/ack`)
log("acked all but object-gone; waiting for escalation (30s after raise)…")
const gone = byKind("object-gone")[0]
const deadline = Date.now() + 40_000
while (Date.now() < deadline && !(alerts.get(gone?.id ?? "")?.status === "escalated" && alerts.get(gone.id)?.incId)) await sleep(500)
await sleep(3000)

const g = gone ? alerts.get(gone.id)! : null
const inc = g?.incId ? await (await fetch(`${BASE}/api/incident/${g.incId}`)).json() : null
const labels = await actors.CameraActor.get(cam).trackedLabels()
const prompt = buildPrompt(cam, [{ id: "A", desc: "red hoodie" }], ["yellow tote", "table"])

console.log("\nALERTS (final state, history):")
for (const a of [...alerts.values()].sort((x, y) => x.t - y.t))
    console.log(`  ${a.id} [${a.kind}] "${a.text}" → ${a.status}${a.incId ? ` ${a.incId}` : ""}  history=${JSON.stringify(a.history.map(h => `${h.status}@+${((h.at - a.t) / 1000).toFixed(1)}s`))}`)
console.log("\nINCIDENT for escalated alert:", inc ? `${inc.id} q="${inc.question}" status=${inc.status} transcript=${inc.transcript?.length}` : "none")
console.log("tracked labels:", labels)
console.log("prompt label line:", prompt.split("\n").find(l => l.startsWith("Objects this camera")))

const checks: [string, boolean][] = [
    ["exactly one object-gone", byKind("object-gone").length === 1],
    ["notable raised separately (per-kind debounce)", byKind("notable").length === 1],
    ["crowd +4", byKind("crowd").some(a => a.text === "4 people arrived")],
    ["object-left backpack", byKind("object-left").length === 1],
    ["tamper", byKind("tamper").length === 1],
    ["object-gone escalated with incident", g?.status === "escalated" && !!g.incId],
    ["escalated ~30s after raise", !!g && Math.abs((g.history.find(h => h.status === "escalated")?.at ?? 0) - g.t - 30_000) < 3000],
    ["investigation started", !!inc && inc.transcript?.length > 0],
    ["acked alerts never escalated", [...alerts.values()].filter(a => a.kind !== "object-gone").every(a => a.status === "acknowledged" && !a.history.some(h => h.status === "escalated"))],
    ["prompt asks to reuse labels", !!prompt.includes("Reuse exactly these labels")]
]
console.log("")
for (const [n, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${n}`)
ws.close()
process.exit(checks.every(c => c[1]) ? 0 : 1)

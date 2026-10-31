// Track A: tuned big-change alerts + escalation, through the real server pipeline (POST /api/debug/observe). WIPES the site.
// Usage: bun scripts/a-alerts.ts   (server on :3000). ~50s (waits for the 30s escalation).
import { actors } from "../generated/index.js"
import type { Alert } from "../src/shared/types.js"
import { isValuable } from "../src/words.js"

const BASE = "http://127.0.0.1:3000"
const post = async (path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    return res.json() as Promise<any>
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const T0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)

await post("/api/site/wipe")
const cams: string[] = []
for (let i = 0; i < 6; i++) cams.push((await post("/api/cameras")).id)
const [demo, noise, crowdCam, leftCam, tamperCam, warmCam] = cams
for (const c of cams.slice(0, 5)) await actors.CameraActor.get(c).skipWarmup() // warmCam keeps its 60s warm-up

const { websocketUrl } = await post("/api/socket/site")
const ws = new WebSocket(websocketUrl)
const alerts = new Map<string, Alert & { seenAt: number }>()
ws.onmessage = e => {
    const ev = JSON.parse(String(e.data))
    if (ev.type !== "alert") return
    const a = ev.alert as Alert
    if (alerts.get(a.id)?.status !== a.status) log(`ALERT ${a.id} ${a.camId} ${a.kind} "${a.text}" → ${a.status}${a.incId ? ` (${a.incId})` : ""} escalateAt=${a.escalateAt ? "+30s" : 0}`)
    alerts.set(a.id, { ...a, seenAt: alerts.get(a.id)?.seenAt ?? Date.now() })
}
await new Promise(r => (ws.onopen = r))

const P = (id: string, x: number, w = 0.1) => ({ id, desc: `person ${id}`, x, y: 0.35, w, h: 0.4, action: "standing" })
const table = { label: "table", x: 0.5, y: 0.75 }
const f = (cam: string, people: any[], objects: any[], extra: Record<string, unknown> = {}) =>
    post("/api/debug/observe", { cam, t: Date.now(), people, objects, notable: null, ...extra })

// 1. DEMO PATH on `demo`: tote on the table, A walks up, picks it up (model also says so), carries it out of frame.
//    Also a phone and a water bottle that vanish (never alert: not valuables).
const tote = (x: number, heldBy?: string) => ({ label: "yellow tote", x, y: 0.62, ...(heldBy ? { heldBy } : {}) })
const junk = [{ label: "phone", x: 0.2, y: 0.8 }, { label: "water bottle", x: 0.8, y: 0.8 }]
await f(demo, [P("new", 0.05)], [tote(0.55), table, ...junk]); await sleep(1000) // A appears
for (let i = 0; i < 6; i++) { await f(demo, [P("A", 0.05)], [tote(0.55), table, ...junk]); await sleep(1000) }
await f(demo, [P("A", 0.5)], [tote(0.55), table]); await sleep(1000) // A at the table (phone + bottle gone too)
await f(demo, [P("A", 0.5)], [tote(0.55, "A"), table], { notable: "person A picks up the yellow tote" }); await sleep(1000)
await f(demo, [P("A", 0.8)], [tote(0.85, "A"), table]); await sleep(1000) // carrying it towards the edge
const tLeft = Date.now()
await f(demo, [], [table]); await sleep(1000) // A and the tote leave the frame (motion frame)
await f(demo, [], [table]); await sleep(1000) // settle 1
await f(demo, [], [table]); await sleep(1000) // settle 2
await f(demo, [], [table], { heartbeat: true })
const gone = [...alerts.values()].find(a => a.camId === demo && a.kind === "object-gone")
log(`demo: object-gone ${gone ? `"${gone.text}" ${((gone.seenAt - tLeft) / 1000).toFixed(1)}s after leaving the frame` : "MISSING"}`)

// 2. NOISE on `noise`: a laptop; B stands in front of it for 5 frames (laptop not visible), then steps away.
const laptop = { label: "laptop", x: 0.5, y: 0.55 }
for (let i = 0; i < 7; i++) await f(noise, [], [laptop, table])
for (let i = 0; i < 5; i++) await f(noise, [P(i ? "B" : "new", 0.42, 0.18)], [table]) // B's box covers the laptop
for (let i = 0; i < 3; i++) await f(noise, [P("B", 0.05)], [laptop, table])
for (let i = 0; i < 3; i++) await f(noise, [], [laptop, table])

// 3. CROWD on `crowdCam`: 1 → 5 people for 3 frames (notify only), then a model notable within 20s (capped).
for (let i = 0; i < 3; i++) await f(crowdCam, [P(i ? "C" : "new", 0.1)], [])
const five = (pre: boolean) => [0, 1, 2, 3, 4].map(i => P(pre && i ? "new" : ["C", "D", "E", "F", "G"][i], 0.1 + i * 0.15, 0.08))
await f(crowdCam, five(true), [])
for (let i = 0; i < 2; i++) await f(crowdCam, five(false), [])
await f(crowdCam, five(false), [], { notable: "people gather" })

// 4. OBJECT-LEFT on `leftCam`: a backpack appears after the opening scene and nobody is near it for 5 frames.
for (let i = 0; i < 4; i++) await f(leftCam, [P(i ? "H" : "new", 0.05)], [table])
for (let i = 0; i < 5; i++) await f(leftCam, [P("H", 0.05)], [table, { label: "backpack", x: 0.85, y: 0.8 }])

// 5. TAMPER (phone sends &tamper=covered after 3s dark/flat)
await f(tamperCam, [], [], { tamper: "covered", heartbeat: true })
// 6. WARM-UP: a brand-new camera's notable within its first 60s → nothing
await f(warmCam, [], [], { notable: "person picks up a bag" })
await sleep(1000)

const of = (cam: string, kind?: string) => [...alerts.values()].filter(a => a.camId === cam && (!kind || a.kind === kind))
// Ack everything that escalates except the demo object-gone, which must escalate on its own.
for (const a of alerts.values()) if (a.escalateAt && a.id !== gone?.id) await post(`/api/alerts/${a.id}/ack`)
log("waiting for the demo object-gone to escalate (30s after raise)…")
const deadline = Date.now() + 40_000
while (Date.now() < deadline && !(gone && alerts.get(gone.id)?.status === "escalated" && alerts.get(gone.id)?.incId)) await sleep(500)
await sleep(2000)

console.log("\nALERTS (final, history):")
for (const a of [...alerts.values()].sort((x, y) => x.t - y.t))
    console.log(`  ${a.id} ${a.camId} [${a.kind}] "${a.text}" → ${a.status}${a.incId ? ` ${a.incId}` : ""} escalateAt=${a.escalateAt ? "t+30s" : 0} history=${JSON.stringify(a.history.map(h => `${h.status}@+${((h.at - a.t) / 1000).toFixed(1)}s`))}`)
const g = gone ? alerts.get(gone.id)! : null
const notable = of(demo, "notable")[0]
const checks: [string, boolean, unknown?][] = [
    ["demo: object-gone 'Yellow tote is gone from the table…'", !!gone && gone.text.startsWith("Yellow tote is gone from the table"), gone?.text],
    ["demo: fires ≤ 4s after leaving the frame (sim, + ~1s vision)", !!gone && (gone.seenAt - tLeft) / 1000 <= 4, gone && (gone.seenAt - tLeft) / 1000],
    ["demo: model notable also shown, notify-only (escalateAt 0; later claimed by the case)", !!notable && notable.escalateAt === 0 && notable.status !== "escalated"],
    ["demo: phone / water bottle never alert", of(demo).every(a => !/phone|bottle/i.test(a.text))],
    ["demo: object-gone escalated with an incident", g?.status === "escalated" && !!g.incId, g?.incId],
    ["noise: person in front of laptop → 0 alerts", of(noise).length === 0, of(noise).map(a => a.text)],
    ["crowd: '4 people arrived', notify-only", of(crowdCam, "crowd").length === 1 && of(crowdCam, "crowd")[0].text === "4 people arrived" && of(crowdCam, "crowd")[0].escalateAt === 0],
    ["crowd: following notable within 20s suppressed", of(crowdCam, "notable").length === 0],
    ["object-left: backpack", of(leftCam, "object-left").length === 1, of(leftCam).map(a => a.text)],
    ["tamper covered escalates (escalateAt set)", of(tamperCam, "tamper").length === 1 && of(tamperCam, "tamper")[0].escalateAt > 0],
    ["warm-up: new camera raises nothing", of(warmCam).length === 0],
    ["notify-only alerts never escalated", [...alerts.values()].filter(a => !a.escalateAt).every(a => !a.history.some(h => h.status === "escalated"))],
    ["valuables allowlist", isValuable("yellow tote") && isValuable("laptop") && isValuable("cardboard box") && isValuable("helmet") && !isValuable("phone") && !isValuable("water bottle") && !isValuable("keyboard") && !isValuable("laptop keyboard")]
]
console.log("")
for (const [n, ok, d] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? `  ${JSON.stringify(d)}` : ""}`)
ws.close()
process.exit(checks.every(c => c[1]) ? 0 : 1)

// Track A sim: synthetic observations through the real server pipeline (POST /api/debug/observe), no images, no LLM.
// WIPES the site first. Checks:
//   1. wipe → next cameras are cam-1, cam-2
//   2. A leaves cam-1 right, enters cam-2 left (2-frame entry) → exactly one learned edge cam-1:right->cam-2:left
//   3. A, B, C each leave cam-2 via top, unmatched → blind spot cam-2:top only after the 3rd (count 3)
//   4. D and E leave cam-1 together (crowd) → nothing learned when D then enters cam-2
//   5. F fades out mid-frame on cam-1 (center) → no blind spot, no edge
//   6. entity ids after Z are A2, B2…
// Usage: bun scripts/a-sim.ts   (server on :3000)
import { actors } from "../generated/index.js"

const BASE = "http://127.0.0.1:3000"
const post = async (path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    return res.json() as Promise<any>
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const T0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)

await post("/api/site/wipe")
const c1 = (await post("/api/cameras")).id
const c2 = (await post("/api/cameras")).id
log("after wipe registered", c1, c2)

const { websocketUrl } = await post("/api/socket/site")
const ws = new WebSocket(websocketUrl)
const events: any[] = []
ws.onmessage = e => {
    const ev = JSON.parse(String(e.data))
    events.push(ev)
    if (ev.type === "edge") log("EVENT edge", ev.edge.id, "transits", ev.edge.transits, "isNew", ev.isNew)
    else if (ev.type === "blind-spot") log("EVENT blind-spot", JSON.stringify(ev.spot))
}
await new Promise(r => (ws.onopen = r))

type P = { id: string; at: "c" | "l" | "r" | "t" }
const box = (p: P) => {
    const pos = { c: [0.45, 0.35, 0.3], l: [0.02, 0.35, 0.3], r: [0.86, 0.35, 0.3], t: [0.45, 0.0, 0.2] }[p.at]
    return { id: p.id, desc: `person ${p.id}`, x: pos[0], y: pos[1], w: 0.1, h: pos[2], action: "walking" }
}
// One frame on both cameras, then 0.8s.
const step = async (a: P[], b: P[]) => {
    const t = Date.now()
    await post("/api/debug/observe", { cam: c1, t, people: a.map(box), objects: [], notable: null })
    await post("/api/debug/observe", { cam: c2, t, people: b.map(box), objects: [], notable: null })
    await sleep(800)
}
// First appearance uses "new"; the site assigns A, B, C… in order of first appearance.
const N = (at: P["at"]): P => ({ id: "new", at })
const I = (id: string, at: P["at"]): P => ({ id, at })

// 2. edge
await step([N("c")], [])               // A
await step([I("A", "r")], [])
await step([], [])
await step([], [I("A", "l")])          // cam-1 2nd miss → exit A right; cam-2 sees A once (not yet entered)
await step([], [I("A", "l")])          // entered → matches → edge
// 3. three unmatched exits via cam-2 top
await step([], [I("A", "t")])
await step([], [])
await step([], [])                     // exit A top
await step([], [N("t")])               // B
await step([], [I("B", "t")])
await step([], [])
await step([], [])                     // exit B top
await step([], [N("t")])               // C
await step([], [I("C", "t")])
await step([], [])
await step([], [])                     // exit C top
// 4. crowd: D and E leave cam-1 together, then D shows up on cam-2
await step([N("r"), N("r")], [])       // D, E
await step([I("D", "r"), I("E", "r")], [])
await step([], [])
await step([], [])                     // both exit right within 2s → ignored
await step([], [I("D", "l")])
await step([], [I("D", "l")])          // D entered cam-2: must NOT learn a transit
// 5. center fade-out
await step([N("c")], [])               // F
await step([I("F", "c")], [])
await step([], [])
await step([], [])                     // exit F center → ignored
log("frames done; waiting for blind-spot alarms (20s after each exit)…")
await sleep(19_000)

const edgeEvents = events.filter(e => e.type === "edge")
const spots = events.filter(e => e.type === "blind-spot").map(e => e.spot)
const site = await actors.SiteActor.get("site").snapshot()

// 6. ids after Z (separate scratch site actor)
const scratch = actors.SiteActor.get(`a-sim-ids-${Date.now()}`)
const ids = (await scratch.resolveEntities(Array.from({ length: 28 }, () => ({ id: "new", desc: "x", x: 0, y: 0, w: 0, h: 0, action: "" })))).map(p => p.id)

const checks: [string, boolean, unknown][] = [
    ["wipe → cam-1, cam-2", c1 === "cam-1" && c2 === "cam-2", [c1, c2]],
    ["exactly one edge event (cam-1:right->cam-2:left)", edgeEvents.length === 1 && edgeEvents[0].edge.id === "cam-1:right->cam-2:left", edgeEvents.map(e => `${e.edge.id} ${e.edge.transits}`)],
    ["blind spot cam-2:top with count 3", spots.some(s => s.camId === "cam-2" && s.edge === "top" && s.count === 3), spots],
    ["no blind spot broadcast before count 3", spots.every(s => s.count >= 3), spots],
    ["no center blind spot", !site.blindSpots.some(b => b.edge === "center"), site.blindSpots],
    ["entities A–F only", site.entities.map(e => e.id).join(",") === "A,B,C,D,E,F", site.entities.map(e => e.id)],
    ["ids after Z: A2, B2", ids[25] === "Z" && ids[26] === "A2" && ids[27] === "B2", ids.slice(24)]
]
console.log("")
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`)
ws.close()
process.exit(checks.every(c => c[1]) ? 0 : 1)

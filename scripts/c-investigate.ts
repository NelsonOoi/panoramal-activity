// Track C evidence (b)(c)(d): full investigation on a synthetic bag-taking story, then a late witness.
//   RELAY_AGENT_PREFIX=ct- RELAY_TOKENS_FILE=.relay-tokens.test.json bun scripts/c-investigate.ts
//   add RELAY_LOCAL_DELIVERY=0 to run every message over Relay only; add SKIP_ADMIT=1 to stop after the verdict.
import { actors } from "../generated/index.js"
import { __setTestHooks, admitWitness, ensureCameraAgent, runInvestigation, startRelay } from "../src/relay.ts"
import type { DashEvent, Observation, Person } from "../src/shared/types.ts"

const T0 = Date.now() - 50_000
const at = (s: number) => T0 + s * 1000
const P = (id: string, desc: string, action: string, x: number, y = 0.4): Person => ({ id, desc, x, y, w: 0.15, h: 0.4, action })
const obs = (camId: string, s: number, people: Person[], objects: Observation["objects"] = [], notable: string | null = null): Observation =>
    ({ camId, t: at(s), frameRef: `/frames/${camId}/${at(s)}.jpg`, people, objects, notable })

const A2 = "man, navy jacket, grey backpack"
const A3 = "man, black jacket, dark backpack" // cam-3 is backlit: same man, jacket reads black
const B = "woman, red hoodie"
const bag = (heldBy?: string) => [{ label: "black bag", x: 0.5, y: 0.6, ...(heldBy ? { heldBy } : {}) }]

const LOGS: Record<string, Observation[]> = {
    "cam-1": [
        obs("cam-1", 0, [P("A", A2, "walking in through the front door", 0.02)]),
        obs("cam-1", 2, [P("A", A2, "walking across the entrance", 0.45)]),
        obs("cam-1", 4, [P("A", A2, "walking toward the table area", 0.85)]),
        obs("cam-1", 7, [])
    ],
    "cam-2": [
        obs("cam-2", 5, [P("B", B, "sitting at the table", 0.5)], bag()),
        obs("cam-2", 8, [P("B", B, "sitting at the table", 0.5), P("A", A2, "entering, walking toward the table", 0.03)], bag()),
        obs("cam-2", 11, [P("B", B, "standing up and walking away", 0.55, 0.2), P("A", A2, "standing near the table", 0.35)], bag()),
        obs("cam-2", 13, [P("A", A2, "standing at the table, looking around", 0.4)], bag()),
        obs("cam-2", 15, [P("A", A2, "picking up the black bag from the table", 0.45)], bag("A"), "bag picked up"),
        obs("cam-2", 17, [P("A", A2, "walking away carrying the black bag", 0.5, 0.05)], bag("A")),
        obs("cam-2", 19, [], [])
    ],
    "cam-3": [
        obs("cam-3", 9, [P("A", A3, "approaching the table, face in shadow", 0.9)], bag()),
        obs("cam-3", 15, [P("A", A3, "reaching for the bag on the table", 0.55)], bag("A")),
        obs("cam-3", 17, [P("A", A3, "walking away with the bag", 0.1)], bag("A")),
        obs("cam-3", 19, [], [])
    ],
    "guest-ct": [
        obs("guest-ct", 22, [P("A", "man, navy jacket, grey backpack, carrying a black bag", "walking fast along the corridor toward the side exit", 0.3)]),
        obs("guest-ct", 26, [P("A", "man, navy jacket, grey backpack, carrying a black bag", "pushing the side exit door open", 0.7)]),
        obs("guest-ct", 29, [])
    ]
}

__setTestHooks({
    recall: async (camId, t0, t1) => (LOGS[camId] ?? []).filter(o => o.t >= t0 && o.t <= t1),
    paths: async () => [
        { entityId: "A", desc: A2, points: [{ t: at(0), camId: "cam-1", inferred: false }, { t: at(8), camId: "cam-2", inferred: false }, { t: at(19), camId: "cam-2", inferred: false }, { t: at(25), camId: "cam-2", inferred: true }] },
        { entityId: "B", desc: B, points: [{ t: at(5), camId: "cam-2", inferred: false }, { t: at(13), camId: "cam-2", inferred: false }] }
    ],
    layout: async () => ({
        edges: [{ id: "cam-1:right->cam-2:left", from: { camId: "cam-1", edge: "right" }, to: { camId: "cam-2", edge: "left" }, transits: [3200, 3900] }],
        blindSpots: [{ camId: "cam-2", edge: "top", count: 2 }]
    })
})

// Dashboard socket: via the server if it is up, else straight from the actor runtime.
const events: DashEvent[] = []
let wsUrl: string
try {
    const r = await fetch("http://127.0.0.1:3000/api/socket/site", { method: "POST" })
    wsUrl = ((await r.json()) as any).websocketUrl
    console.log("socket via :3000")
} catch {
    wsUrl = ((await actors.SiteActor.prepareWebsocket({ actorId: "site", metadata: { role: "dashboard" } })) as any).websocketUrl
    console.log("socket via prepareWebsocket")
}
const ws = new WebSocket(wsUrl)
const incId = `inc-c${Date.now().toString(36)}`
const start = Date.now()
const el = () => `+${((Date.now() - start) / 1000).toFixed(1)}s`
ws.onmessage = e => {
    const ev = JSON.parse(String(e.data)) as DashEvent
    if (ev.type === "relay" && ev.card.incId && ev.card.incId !== incId) return
    if (ev.type === "incident" && ev.incident.id !== incId) return
    if (ev.type !== "relay" && ev.type !== "incident" && ev.type !== "knock") return
    events.push(ev)
    if (ev.type === "relay") console.log(el(), "card", ev.card.kind, ev.card.from, "->", ev.card.to, "|", ev.card.text.slice(0, 110))
    if (ev.type === "incident") console.log(el(), "incident", ev.incident.status, "rev", ev.incident.revision, ev.incident.witnesses.map(w => `${w.camId}:${w.status}`).join(" "), ev.changed.length ? `changed=${ev.changed}` : "")
    if (ev.type === "knock") console.log(el(), "knock", ev.knock.status, ev.knock.message)
}
await new Promise(r => (ws.onopen = r))

console.log("local delivery:", process.env.RELAY_LOCAL_DELIVERY !== "0", "incId:", incId)
await startRelay()
await Promise.all(["cam-1", "cam-2", "cam-3"].map(ensureCameraAgent))
console.log(el(), "relay ready")

const inc = actors.IncidentActor.get(incId)
await inc.open("Who took the black bag from the table?", [at(-5), at(40)], ["cam-1", "cam-2", "cam-3"])
await runInvestigation(incId)
let s = (await inc.get())!
const show = () => {
    console.log(`\n=== ${s.id} rev ${s.revision} status ${s.status}`)
    for (const i of s.timeline) console.log(` ${i.id} [${new Date(i.t).toISOString().slice(11, 19)}]${i.inferred ? " (inferred)" : ""} ${i.claim}  <- ${i.citations.map(c => `${c.camId}@${c.frameRef.split("/").pop()}`).join(", ")}${i.revisedFrom ? `\n      revisedFrom: ${i.revisedFrom}` : ""}`)
    for (const c of s.contradictions) console.log(` ${c.id} ${c.cams.join(" vs ")}: "${c.a}" / "${c.b}" -> ${c.resolution}`)
    console.log(" summary:", s.summary)
    console.log(" transcript:", s.transcript.map(c => `${c.kind}:${c.from}`).join(" "))
}
show()

if (!process.env.SKIP_ADMIT) {
    const site = actors.SiteActor.get("site")
    await site.putKnock({ guestId: "guest-ct", offer: "clip of the corridor", status: "approved", message: null })
    await ensureCameraAgent("guest-ct")
    await admitWitness("guest-ct", incId)
    s = (await inc.get())!
    show()
    console.log(" knock:", (await site.getKnock("guest-ct"))?.message)
}

if (process.env.RELAY_LOCAL_DELIVERY === "0" || process.env.LINGER) {
    console.log("lingering 30s for late Relay deliveries…")
    await new Promise(r => setTimeout(r, 30_000))
}
const count: Record<string, number> = {}
for (const e of events) count[e.type === "relay" ? `relay:${e.card.kind}` : e.type] = (count[e.type === "relay" ? `relay:${e.card.kind}` : e.type] ?? 0) + 1
console.log("\ndashboard events received:", count)
process.exit(0)

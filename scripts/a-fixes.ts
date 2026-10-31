// Track A: demo-critical fixes. WIPES the site. ~50s.
//  1. object-gone delay in a still room (exit frame → 2 settle frames → heartbeats), and with heartbeats only
//  2. two alerts 2s apart → investigate one → both investigating, same incId → no escalation after 30s
//  3. guest alignment with synonyms/stemming ("picks up bag" vs "picked up the yellow tote")
import { alignOffset, matchScore, normWords } from "../src/align.js"
import type { Alert, Observation } from "../src/shared/types.js"

const BASE = "http://127.0.0.1:3000"
const post = async (path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    return res.json() as Promise<any>
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const checks: [string, boolean, unknown?][] = []

await post("/api/site/wipe")
const c1 = (await post("/api/cameras")).id
const c2 = (await post("/api/cameras")).id
const { websocketUrl } = await post("/api/socket/site")
const ws = new WebSocket(websocketUrl)
const alerts = new Map<string, Alert & { seenAt: number }>()
ws.onmessage = e => {
    const ev = JSON.parse(String(e.data))
    if (ev.type === "alert") alerts.set(ev.alert.id, { ...ev.alert, seenAt: alerts.get(ev.alert.id)?.seenAt ?? Date.now() })
}
await new Promise(r => (ws.onopen = r))

const walker = (x: number) => ({ id: "A", desc: "walker", x, y: 0.4, w: 0.08, h: 0.3, action: "walking" })
const obs = (cam: string, people: any[], objects: any[], extra: Record<string, unknown> = {}) =>
    post("/api/debug/observe", { cam, t: Date.now(), people, objects, notable: null, ...extra })
const tote = (x = 0.5) => ({ label: "yellow tote", x, y: 0.62 })
const table = { label: "table", x: 0.52, y: 0.7 }

// ---- 1a: cam-1 with settle frames (what capture.ts now sends)
for (let i = 0; i < 4; i++) { await obs(c1, [walker(0.3 + i * 0.1)], [tote(0.3 + i * 0.1), table]); await sleep(1000) }
const tExit1 = Date.now()
await obs(c1, [], [table]); await sleep(1000)                // motion frame: walker + tote out of frame
await obs(c1, [], [table]); await sleep(1000)                // settle 1
await obs(c1, [], [table]); await sleep(1000)                // settle 2
await obs(c1, [], [table], { heartbeat: true })              // heartbeat (+3s)
await sleep(500)
// ---- 1b: cam-2 heartbeats only (old phone build: no settle frames)
for (let i = 0; i < 4; i++) { await obs(c2, [walker(0.3 + i * 0.1)], [{ label: "laptop", x: 0.5, y: 0.5 }, table]); await sleep(1000) }
const tExit2 = Date.now()
await obs(c2, [], [table]); await sleep(3000)
await obs(c2, [], [table], { heartbeat: true }); await sleep(3000)
await obs(c2, [], [table], { heartbeat: true }); await sleep(500)

const gone1 = [...alerts.values()].find(a => a.kind === "object-gone" && a.camId === c1)
const gone2 = [...alerts.values()].find(a => a.kind === "object-gone" && a.camId === c2)
const d1 = gone1 ? (gone1.seenAt - tExit1) / 1000 : null
const d2 = gone2 ? (gone2.seenAt - tExit2) / 1000 : null
console.log(`1a object-gone with settle frames: "${gone1?.text}" ${d1?.toFixed(1)}s after the object left (plus ~1s real vision latency)`)
console.log(`1b object-gone with heartbeats only: "${gone2?.text}" ${d2?.toFixed(1)}s after the object left`)
checks.push(["object-gone fires with settle frames ≤ 4s (sim)", d1 !== null && d1 <= 4, d1])
checks.push(["object-gone fires from heartbeat absence alone", d2 !== null, d2])
for (const a of alerts.values()) await post(`/api/alerts/${a.id}/ack`) // keep part 2 clean

// ---- 3: alignment
const o = (camId: string, t: number, notable: string | null, objects: string[] = [], action = "standing"): Observation =>
    ({ camId, t, frameRef: "", people: [{ id: "A", desc: "", x: 0, y: 0, w: 0, h: 0, action }], objects: objects.map(label => ({ label, x: 0, y: 0 })), notable })
const g = o("g", 0, "person picks up bag")
console.log("\n3 normWords:", JSON.stringify(normWords("picks up bag")), "vs", JSON.stringify(normWords("picked up the yellow tote")), "vs", JSON.stringify(normWords("Yellow tote is gone")), JSON.stringify(normWords("leaves via the exit")))
const s1 = matchScore(g, o(c1, 0, "picked up the yellow tote"))
const s2 = matchScore(g, o(c1, 0, "Yellow tote is gone"))
console.log(`3 score "picks up bag" vs "picked up the yellow tote" = ${s1}; vs "Yellow tote is gone" = ${s2}`)
checks.push(["align: pickup matches (score ≥ 1)", s1 >= 1, s1], ["align: tote-gone matches (score ≥ 1)", s2 >= 1, s2])
const { guestId } = await post("/api/witness")
const tF = Date.now()
await post("/api/debug/observe", { cam: c1, t: tF, people: [walker(0.5)], objects: [tote()], notable: "person picked up the yellow tote" })
await post("/api/debug/observe", { cam: guestId, guest: true, t: tF - 7000, people: [{ ...walker(0.5), action: "picks up bag" }], objects: [{ label: "bag", x: 0.5, y: 0.5 }], notable: "person picks up bag" })
const al = await alignOffset(guestId)
console.log(`3 alignOffset(${guestId}) =`, JSON.stringify(al), "(expected ≈ +7000)")
checks.push(["align: guest offset ≈ +7000ms", Math.abs(al.offsetMs - 7000) < 500, al])
for (const a of alerts.values()) if (a.status === "raised") await post(`/api/alerts/${a.id}/ack`)

// ---- 2: two alerts 2s apart, investigate one
await obs(c2, [walker(0.5)], [table], { notable: "person waves at the camera" })
await sleep(2000)
await obs(c2, [walker(0.5)], [table], { tamper: "covered", heartbeat: true })
await sleep(500)
const fresh = [...alerts.values()].filter(a => a.status === "raised")
const [first, second] = fresh.sort((a, b) => a.t - b.t)
const { incId } = await post("/api/incident", { alertId: first.id })
await sleep(800)
const a1 = alerts.get(first.id)!, a2 = alerts.get(second.id)!
console.log(`\n2 investigated ${first.id} → incident ${incId}: ${a1.id} ${a1.status} ${a1.incId}; ${a2.id} ${a2.status} ${a2.incId}`)
checks.push(["both investigating with the same incId", a1.status === "investigating" && a2.status === "investigating" && a1.incId === incId && a2.incId === incId, [a1.status, a2.status]])
console.log("2 waiting 32s for (absence of) escalation…")
await sleep(32_000)
const after = [alerts.get(first.id)!, alerts.get(second.id)!]
for (const a of after) console.log(`  ${a.id} [${a.kind}] ${a.status} ${a.incId} history=${JSON.stringify(a.history.map(h => `${h.status}@+${((h.at - a.t) / 1000).toFixed(1)}s`))}`)
checks.push(["no escalation after 30s", after.every(a => a.status === "investigating" && !a.history.some(h => h.status === "escalated"))])
const all = [...alerts.values()]
checks.push(["no alert escalated anywhere", !all.some(a => a.status === "escalated")])

console.log("")
for (const [n, ok, d] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d !== undefined ? `  ${JSON.stringify(d)}` : ""}`)
ws.close()
process.exit(checks.every(c => c[1]) ? 0 : 1)

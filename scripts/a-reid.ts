// Track A: server-side tracking + re-ID through POST /api/debug/observe (the model returns "new" every time). WIPES the site.
import { actors } from "../generated/index.js"

const BASE = "http://127.0.0.1:3000"
const post = async (path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    return res.json() as Promise<any>
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const site = actors.SiteActor.get("site")
const jit = () => (Math.random() - 0.5) * 0.03

await post("/api/site/wipe")
const [c1, c2, c3, c4] = [(await post("/api/cameras")).id, (await post("/api/cameras")).id, (await post("/api/cameras")).id, (await post("/api/cameras")).id]
const { websocketUrl } = await post("/api/socket/site")
const ws = new WebSocket(websocketUrl)
const edges: string[] = []
ws.onmessage = e => { const ev = JSON.parse(String(e.data)); if (ev.type === "edge") edges.push(ev.edge.id) }
await new Promise(r => (ws.onopen = r))

const person = (desc: string, x: number, y = 0.3, w = 0.12, h = 0.45) => ({ id: "new", desc, x: x + jit(), y: y + jit(), w: w + jit() / 3, h: h + jit() / 3, action: "walking" })
const frame = (cam: string, people: any[]) => post("/api/debug/observe", { cam, t: Date.now(), people, objects: [], notable: null })
const lastIds = async (cam: string) => ((await (await fetch(`${BASE}/api/cameras/${cam}/recent?limit=1`)).json()) as any[])[0]?.people.map((p: any) => p.id) ?? []
const entities = async () => (await site.snapshot()).entities

// (a) one person crossing cam-1 in 8 jittered frames
const WHITE = "top: white t-shirt; bottom: blue jeans; head: short black hair; carrying: none"
for (let i = 0; i < 8; i++) { await frame(c1, [person(WHITE, 0.1 + i * 0.1)]); await sleep(300) }
const ea = await entities()
console.log("(a) entities after 8 frames on cam-1:", JSON.stringify(ea))
await frame(c1, []); await sleep(300)
await frame(c1, []) // exit right
await sleep(2400)

// (b) enters cam-2 from the left ~3s later, same outfit, different wording
const WHITE2 = "top: white tee; bottom: blue denim jeans; head: black hair; carrying: nothing"
await frame(c2, [person(WHITE2, 0.01)]); await sleep(300)
await frame(c2, [person(WHITE2, 0.05)]); await sleep(500)
const idsB = await lastIds(c2)
const eb = await entities()
console.log("(b) cam-2 ids:", idsB, "entities:", eb.map(e => e.id), "edges:", edges)

// (c) two different people side by side on cam-3 for 8 frames, drifting towards each other (never crossing)
const W3 = "top: white hoodie; bottom: black trousers; head: grey beanie; carrying: none"
const K3 = "top: black jacket; bottom: grey trousers; head: brown curly hair; carrying: red backpack"
const pairs: string[] = []
for (let i = 0; i < 8; i++) {
    await frame(c3, [person(W3, 0.25 + i * 0.015), person(K3, 0.5 - i * 0.015)])
    const recent = ((await (await fetch(`${BASE}/api/cameras/${c3}/recent?limit=1`)).json()) as any[])[0]
    const white = recent.people.find((p: any) => p.desc.includes("white hoodie"))?.id
    const black = recent.people.find((p: any) => p.desc.includes("black jacket"))?.id
    pairs.push(`${white}/${black}`)
    await sleep(200)
}
const ec = await entities()
console.log("(c) white/black ids per frame:", pairs.join(" "), "entities:", ec.map(e => e.id))

// (d) fragments on cam-4
const before = (await entities()).length
for (let i = 0; i < 3; i++) {
    await frame(c4, [
        { id: "new", desc: "arm in white sleeve", x: 0.9, y: 0.4, w: 0.1, h: 0.4, action: "" },
        { id: "new", desc: "top: white sleeve; bottom: unknown; head: unknown; carrying: none", x: 0.0, y: 0.5, w: 0.1, h: 0.4, action: "" },
        { id: "new", desc: "top: red shirt; bottom: blue jeans; head: unknown; carrying: none", x: 0.5, y: 0.5, w: 0.08, h: 0.2, action: "" },
        { id: "new", desc: "dark clothing, partial arm visible", x: 0.3, y: 0.3, w: 0.2, h: 0.5, action: "" }
    ])
}
const ed = (await entities()).length - before
console.log("(d) new entities from fragments:", ed)

const checks: [string, boolean][] = [
    ["(a) one person across 8 jittered frames → 1 entity", ea.length === 1],
    ["(b) same id on cam-2 with different wording", eb.length === 1 && idsB[0] === ea[0]?.id],
    ["(b) edge learned cam-1:right->cam-2:left", edges.includes(`${c1}:right->${c2}:left`)],
    ["(c) two people → 2 new entities, never swapped", ec.length === 3 && new Set(pairs).size === 1 && !pairs[0].includes("undefined")],
    ["(d) fragments → 0 entities", ed === 0]
]
console.log("")
for (const [n, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${n}`)
ws.close()
process.exit(checks.every(c => c[1]) ? 0 : 1)

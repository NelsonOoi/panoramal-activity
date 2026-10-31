import { actors } from "../generated/index.js"
const s = await actors.SiteActor.get("site").snapshot()
const byKind: Record<string, number> = {}
for (const a of s.alerts) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
console.log("cameras", s.cameras.map(c => `${c.id}:${c.observations}`).join(" "), "| alerts", s.alerts.length, JSON.stringify(byKind))
for (const a of s.alerts.slice(0, 20)) console.log(new Date(a.t).toLocaleTimeString(), a.camId, a.kind.padEnd(11), a.status.padEnd(13), a.text)
process.exit(0)

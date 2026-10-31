import { actors } from "../generated/index.js"
const s = await actors.SiteActor.get("site").snapshot()
console.log("current", s.currentIncidentId, "edges", s.edges.length, "blind", s.blindSpots.map(b => `${b.camId}:${b.edge}x${b.count}`).join(" "), "entities", s.entities.length)
for (let i = 1; i <= 12; i++) {
  const inc = await actors.IncidentActor.get(`inc-${i}`).get().catch(() => null)
  if (inc) console.log(inc.id, JSON.stringify(inc.question), inc.status, new Date(inc.window[0]).toLocaleTimeString(), "witnesses", inc.witnesses.map(w => w.camId).join(","), "items", inc.timeline.length)
}
process.exit(0)

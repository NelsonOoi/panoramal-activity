import { actors } from "../generated/index.js"
for (let i = 1; i <= 40; i++) {
  const inc = await actors.IncidentActor.get(`inc-${i}`).get().catch(() => null)
  if (!inc) continue
  const cites = inc.timeline.reduce((n, t) => n + t.citations.length, 0)
  const steps = inc.paths.reduce((n, p) => n + p.points.length, 0)
  console.log(inc.id, JSON.stringify(inc.question).slice(0, 70), "| witnesses", inc.witnesses.length, "| items", inc.timeline.length, "cites", cites, "| paths", inc.paths.length, "steps", steps)
}
process.exit(0)

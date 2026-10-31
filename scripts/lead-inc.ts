import { actors } from "../generated/index.js"
const inc = await actors.IncidentActor.get(process.argv[2]).get()
for (const c of inc!.transcript) console.log(c.kind, c.from, "->", c.to, "|", c.text.slice(0, 160))
console.log("SUMMARY:", inc!.summary?.slice(0, 400))
process.exit(0)

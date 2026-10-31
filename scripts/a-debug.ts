import { actors } from "../generated/index.js"
const d = await actors.SiteActor.get("site").debugLayout()
const now = Date.now()
const fmt = (l: any[]) => l.map(e => `${e.entityId}@${e.camId}:${e.edge} ${((now - e.t) / 1000).toFixed(1)}s ago`)
console.log({ pending: fmt(d.pendingExits), recentExits: fmt(d.recentExits), recentEntries: fmt(d.recentEntries), exitMisses: d.exitMisses })
process.exit(0)

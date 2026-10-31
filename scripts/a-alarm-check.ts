// Is the SiteActor alarm delivered at all? Uses a scratch SiteActor that no server tick touches.
import { actors } from "../generated/index.js"
const s = actors.SiteActor.get(`alarm-test-${Date.now()}`)
const a = await s.createAlert({ camId: "x", t: Date.now() - 28_000, text: "alarm test", frameRef: "", kind: "object-gone" })
console.log("created", a?.id, "escalateAt in", ((a!.escalateAt - Date.now()) / 1000).toFixed(1), "s")
const d = await s.debugLayout(); console.log("alarm armed for", d.alarmAt ? ((d.alarmAt - d.now) / 1000).toFixed(1) + "s from now" : "NOTHING")
for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const g = await s.getAlert(a!.id)
    if (g?.status === "escalated") { console.log("ALARM fired:", ((g.history[1].at - g.escalateAt) / 1000).toFixed(2), "s after escalateAt"); process.exit(0) }
}
const d2 = await s.debugLayout(); console.log("alarm did NOT fire within 12s; alarmAt now", d2.alarmAt && ((d2.alarmAt - d2.now) / 1000).toFixed(1)); process.exit(1)

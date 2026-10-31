import { actors } from "../generated/index.js"
const site = actors.SiteActor.get("check-site")
console.log("cameras", await site.listCameras())
const grant = await actors.SiteActor.prepareWebsocket({ actorId: "check-site", metadata: { role: "dashboard" } })
console.log("grant keys", Object.keys(grant), String((grant as any).websocketUrl).slice(0, 60))
const ws = new WebSocket((grant as any).websocketUrl)
const got: string[] = []
ws.onmessage = e => got.push(String(e.data).slice(0, 120))
await new Promise(r => (ws.onopen = r))
const t0 = Date.now()
await site.publish({ type: "layout-reset" })
await new Promise(r => setTimeout(r, 500))
console.log("received", got, "publish took", Date.now() - t0, "ms")
ws.close(); process.exit(0)

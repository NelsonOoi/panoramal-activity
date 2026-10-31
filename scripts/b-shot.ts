// Track B: headless screenshots of the dashboard over time via raw CDP.
// bun scripts/b-shot.ts <url> <outPrefix> <w>x<h> <ms,ms,...> [clickSelector@ms ...]
import { spawn } from "node:child_process"

const [url, out, size = "1920x1080", times = "3000", ...clicks] = process.argv.slice(2)
const [w, h] = size.split("x").map(Number)
const bin = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1148/chrome-mac/headless_shell`
const port = 9300 + Math.floor(Math.random() * 500)
const proc = spawn(bin, [`--remote-debugging-port=${port}`, "--no-sandbox", "--hide-scrollbars", `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" })

let ws: WebSocket
for (let i = 0; i < 50; i++) {
    try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
        const page = list.find(p => p.type === "page")
        if (page) {
            ws = new WebSocket(page.webSocketDebuggerUrl)
            break
        }
    } catch {}
    await Bun.sleep(200)
}
await new Promise(r => (ws!.onopen = r))
let id = 0
const pending = new Map<number, (v: any) => void>()
ws!.onmessage = ev => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)!(m.result ?? m.error)
        pending.delete(m.id)
    } else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
        console.log(`[console.${m.params.type}]`, m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 400))
    } else if (m.method === "Runtime.exceptionThrown") {
        console.log("[exception]", m.params.exceptionDetails.exception?.description?.slice(0, 600) ?? m.params.exceptionDetails.text)
    }
}
const send = (method: string, params: object = {}) =>
    new Promise<any>(r => {
        const i = ++id
        pending.set(i, r)
        ws.send(JSON.stringify({ id: i, method, params }))
    })
await send("Runtime.enable")
await send("Page.enable")
await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
await send("Page.navigate", { url })
const t0 = Date.now()
const events = [
    ...times.split(",").map(t => ({ at: Number(t), kind: "shot" as const, arg: t })),
    ...clicks.map(c => {
        const [sel, at] = c.split("@")
        return { at: Number(at), kind: "click" as const, arg: sel }
    })
].sort((a, b) => a.at - b.at)
for (const e of events) {
    const wait = e.at - (Date.now() - t0)
    if (wait > 0) await Bun.sleep(wait)
    if (e.kind === "click" && e.arg.startsWith("drag:")) {
        const [x1, y1, x2, y2] = e.arg.slice(5).split(",").map(Number)
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 })
        for (let i = 1; i <= 8; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8, button: "left", buttons: 1 })
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 })
        console.log("dragged", e.arg)
    } else if (e.kind === "click" && e.arg.startsWith("tap:")) {
        const [x, y] = e.arg.slice(4).split(",").map(Number)
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
        console.log("tapped", e.arg)
    } else if (e.kind === "click") {
        const r = await send("Runtime.evaluate", { expression: `(() => { const el = document.querySelector(${JSON.stringify(e.arg)}); if (!el) return 'missing'; el.dispatchEvent(new MouseEvent('click', {bubbles: true})); return 'ok' })()`, returnByValue: true })
        console.log("click", e.arg, r?.result?.value)
    } else {
        const r = await send("Page.captureScreenshot", { format: "png" })
        await Bun.write(`${out}-${e.arg}.png`, Buffer.from(r.data, "base64"))
        console.log("shot", `${out}-${e.arg}.png`)
    }
}
proc.kill()
process.exit(0)

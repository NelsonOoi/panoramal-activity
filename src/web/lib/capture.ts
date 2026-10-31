// Phone-side capture: clock sync, camera registration, motion-gated 1 fps upload, clip frame extraction. Owner: track A.
import type { CameraMeta } from "../../shared/types"

const CAM_KEY = "panoramal.camId"
const FRAME_WIDTH = 640
const JPEG_QUALITY = 0.6
const TICK_MS = 1000
const HEARTBEAT_MS = 3000
const SETTLE_FRAMES = 2 // full frames sent 1s apart after motion stops
const MOTION_THRESHOLD = 6 // mean absolute grey difference (0–255) on a 32×24 thumbnail

// Tamper detection on the same thumbnail (no extra cost).
const COVERED_MEAN = 20 // mean grey below this = lens covered / dark
const COVERED_STD = 6 // std dev below this = blurred or covered (a flat image)
const MOVED_JUMP = 45 // tick-to-tick mean difference that counts as a near-total change
const MOVED_HOLD = 30 // …and the scene still differs this much from before the jump…
const TAMPER_TICKS = 2 // …for this many ticks
const TAMPER_DEBOUNCE_MS = 15_000 // per kind, on the phone

export function tamperStats(g: Uint8ClampedArray): { mean: number; std: number } {
    let sum = 0
    for (let i = 0; i < g.length; i++) sum += g[i]
    const mean = sum / g.length
    let v = 0
    for (let i = 0; i < g.length; i++) v += (g[i] - mean) ** 2
    return { mean, std: Math.sqrt(v / g.length) }
}

const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
    return sum / a.length
}

// 5× GET /api/time; keep the fastest round trip. offset = serverT − midpoint.
export async function syncClock(): Promise<{ offsetMs: number; errMs: number }> {
    let best = { offsetMs: 0, errMs: Infinity }
    for (let i = 0; i < 5; i++) {
        try {
            const t0 = Date.now()
            const res = await fetch("/api/time", { cache: "no-store" })
            const { t } = (await res.json()) as { t: number }
            const t1 = Date.now()
            const rtt = t1 - t0
            if (rtt / 2 < best.errMs) best = { offsetMs: Math.round(t - (t0 + t1) / 2), errMs: Math.max(1, Math.round(rtt / 2)) }
        } catch {}
    }
    if (!isFinite(best.errMs)) best = { offsetMs: 0, errMs: 5000 }
    return best
}

function storage(): Storage | null {
    try {
        return window.localStorage
    } catch {
        return null
    }
}

// POST /api/cameras, remembering the id in localStorage. The saved id is reused only if the server still
// knows that camera AND the site hasn't been wiped since (epoch from /api/config); otherwise registers fresh.
export async function registerCamera(): Promise<CameraMeta> {
    let epoch = ""
    try {
        epoch = String(((await (await fetch("/api/config", { cache: "no-store" })).json()) as { epoch?: string }).epoch ?? "")
    } catch {}
    let saved: { id: string; epoch: string } | null = null
    try {
        const raw = storage()?.getItem(CAM_KEY)
        if (raw) saved = raw.startsWith("{") ? JSON.parse(raw) : { id: raw, epoch: "" }
    } catch {}
    if (saved?.id && saved.epoch === epoch) {
        try {
            const res = await fetch("/api/cameras", { cache: "no-store" })
            if (res.ok) {
                const hit = ((await res.json()) as CameraMeta[]).find(c => c.id === saved!.id)
                if (hit) return hit
            }
        } catch {}
    }
    const res = await fetch("/api/cameras", { method: "POST" })
    if (!res.ok) throw new Error(`register failed: ${res.status}`)
    const meta = (await res.json()) as CameraMeta
    try {
        storage()?.setItem(CAM_KEY, JSON.stringify({ id: meta.id, epoch }))
    } catch {}
    return meta
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", JPEG_QUALITY)
    )
}

function drawScaled(src: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
    const vw = src.videoWidth, vh = src.videoHeight
    if (!vw || !vh) return false
    const w = Math.min(FRAME_WIDTH, vw)
    canvas.width = w
    canvas.height = Math.round((vh / vw) * w)
    canvas.getContext("2d")!.drawImage(src, 0, 0, canvas.width, canvas.height)
    return true
}

export function startCapture(opts: {
    video: HTMLVideoElement
    camId: string
    offsetMs: number
    onFrame?: (info: { sent: boolean; t: number }) => void
    onError?: (e: Error) => void
}): () => void {
    const { video, camId, offsetMs } = opts
    let stream: MediaStream | null = null
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    let inFlight = false
    let lastSentAt = 0
    let lastThumb: Uint8ClampedArray | null = null
    let settleLeft = 0
    let prevTick: Uint8ClampedArray | null = null
    let coveredTicks = 0
    let moveFrom: { base: Uint8ClampedArray; ticks: number } | null = null
    const tamperSentAt: Record<string, number> = {}

    // Returns "covered" / "moved" once a tamper condition has held for TAMPER_TICKS (debounced per kind).
    const checkTamper = (g: Uint8ClampedArray, now: number): "covered" | "moved" | null => {
        const { mean, std } = tamperStats(g)
        coveredTicks = mean < COVERED_MEAN || std < COVERED_STD ? coveredTicks + 1 : 0
        let kind: "covered" | "moved" | null = coveredTicks >= TAMPER_TICKS ? "covered" : null
        if (!kind && prevTick) {
            if (moveFrom) {
                if (meanDiff(g, moveFrom.base) >= MOVED_HOLD) moveFrom.ticks++
                else moveFrom = null // went back: it was a passer-by, not a move
                if (moveFrom && moveFrom.ticks >= TAMPER_TICKS) {
                    kind = "moved"
                    moveFrom = null
                }
            } else if (meanDiff(g, prevTick) >= MOVED_JUMP) moveFrom = { base: prevTick, ticks: 0 }
        }
        prevTick = g
        if (!kind || now - (tamperSentAt[kind] ?? 0) < TAMPER_DEBOUNCE_MS) return null
        tamperSentAt[kind] = now
        return kind
    }

    const thumb = document.createElement("canvas")
    thumb.width = 32
    thumb.height = 24
    const thumbCtx = thumb.getContext("2d", { willReadFrequently: true })!
    const frame = document.createElement("canvas")

    const grey = (): Uint8ClampedArray => {
        thumbCtx.drawImage(video, 0, 0, 32, 24)
        const d = thumbCtx.getImageData(0, 0, 32, 24).data
        const g = new Uint8ClampedArray(32 * 24)
        for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0
        return g
    }

    const tick = async () => {
        if (stopped || inFlight || !video.videoWidth) return
        const now = Date.now()
        const t = now + offsetMs
        const g = grey()
        let diff = Infinity
        if (lastThumb) {
            let sum = 0
            for (let i = 0; i < g.length; i++) sum += Math.abs(g[i] - lastThumb[i])
            diff = sum / g.length
        }
        const tamper = checkTamper(g, now)
        const motion = diff >= MOTION_THRESHOLD
        // After motion stops, send SETTLE_FRAMES more full frames 1s apart (fresh vision of the now-still scene,
        // so e.g. "object gone" can be confirmed) before falling back to the 3s heartbeat.
        const settle = !motion && settleLeft > 0
        if (!tamper && !motion && !settle && now - lastSentAt < HEARTBEAT_MS) {
            opts.onFrame?.({ sent: false, t })
            return
        }
        // Heartbeat = sent only because 3s passed: the server reuses the last vision result instead of calling the model.
        const heartbeat = !motion && !settle
        if (!drawScaled(video, frame)) return
        inFlight = true
        try {
            const jpeg = await toJpeg(frame)
            const res = await fetch(`/api/ingest?cam=${encodeURIComponent(camId)}&t=${t}${heartbeat ? "&hb=1" : ""}${tamper ? `&tamper=${tamper}` : ""}`, {
                method: "POST",
                headers: { "Content-Type": "image/jpeg" },
                body: jpeg
            })
            if (res.status === 404) {
                // The site was wiped or forgot this camera: forget the id so a reload registers fresh.
                try { storage()?.removeItem(CAM_KEY) } catch {}
                throw new Error("unknown camera (site was reset) - reload this page")
            }
            if (!res.ok) throw new Error(`ingest ${res.status}`)
            lastThumb = g
            lastSentAt = now
            if (motion) settleLeft = SETTLE_FRAMES
            else if (settle) settleLeft--
            opts.onFrame?.({ sent: true, t })
        } catch (e) {
            opts.onError?.(e instanceof Error ? e : new Error(String(e)))
        } finally {
            inFlight = false
        }
    }

    ;(async () => {
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            })
            if (stopped) {
                stream.getTracks().forEach(tr => tr.stop())
                return
            }
            video.srcObject = stream
            video.muted = true
            video.playsInline = true
            video.setAttribute("playsinline", "")
            await video.play().catch(() => {})
            timer = setInterval(() => void tick(), TICK_MS)
        } catch (e) {
            opts.onError?.(e instanceof Error ? e : new Error(String(e)))
        }
    })()

    return () => {
        stopped = true
        if (timer) clearInterval(timer)
        stream?.getTracks().forEach(tr => tr.stop())
        video.srcObject = null
    }
}

function once(el: HTMLElement, event: string, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${event}`)) }, timeoutMs)
        const ok = () => { cleanup(); resolve() }
        const err = () => { cleanup(); reject(new Error("video failed to load")) }
        const cleanup = () => {
            clearTimeout(to)
            el.removeEventListener(event, ok)
            el.removeEventListener("error", err)
        }
        el.addEventListener(event, ok)
        el.addEventListener("error", err)
    })
}

// Draws the clip to a canvas at `fps` by seeking a <video>; no ffmpeg needed.
export async function extractFrames(
    file: File,
    opts: { fps: number; onFrame: (jpeg: Blob, clipMs: number) => Promise<void>; onProgress?: (p: number) => void }
): Promise<{ durationMs: number }> {
    const url = URL.createObjectURL(file)
    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.setAttribute("playsinline", "")
    video.preload = "auto"
    video.src = url
    try {
        if (video.readyState < 1) await once(video, "loadedmetadata")
        let duration = video.duration
        if (!isFinite(duration)) {
            // Some recordings (webm) report Infinity until we seek to the end.
            video.currentTime = 1e9
            await once(video, "seeked").catch(() => {})
            duration = video.duration
            if (!isFinite(duration)) duration = video.currentTime
        }
        // iOS won't decode frames until playback has been started once.
        await video.play().then(() => video.pause()).catch(() => {})
        const canvas = document.createElement("canvas")
        const step = 1 / Math.max(0.1, opts.fps)
        const times: number[] = []
        for (let t = 0; t < duration; t += step) times.push(t)
        if (!times.length) times.push(0)
        for (let i = 0; i < times.length; i++) {
            const t = Math.min(times[i], Math.max(0, duration - 0.05))
            if (Math.abs(video.currentTime - t) > 0.001) {
                const seeked = once(video, "seeked")
                video.currentTime = t
                await seeked
            }
            if (drawScaled(video, canvas)) await opts.onFrame(await toJpeg(canvas), Math.round(times[i] * 1000))
            opts.onProgress?.((i + 1) / times.length)
        }
        return { durationMs: Math.round(duration * 1000) }
    } finally {
        video.removeAttribute("src")
        video.load()
        URL.revokeObjectURL(url)
    }
}

// Screen Wake Lock, re-acquired when the page becomes visible again. Returns release().
export async function keepAwake(): Promise<() => void> {
    let lock: { release(): Promise<void> } | null = null
    let released = false
    const acquire = async () => {
        try {
            const wl = (navigator as any).wakeLock
            if (wl && !released) lock = await wl.request("screen")
        } catch {}
    }
    const onVis = () => {
        if (document.visibilityState === "visible") void acquire()
    }
    await acquire()
    document.addEventListener("visibilitychange", onVis)
    return () => {
        released = true
        document.removeEventListener("visibilitychange", onVis)
        lock?.release().catch(() => {})
        lock = null
    }
}

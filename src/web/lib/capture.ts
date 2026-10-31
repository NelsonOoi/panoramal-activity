// Phone-side capture: clock sync, camera registration, motion-gated 1 fps upload, clip frame extraction. Owner: track A.
import type { CameraMeta } from "../../shared/types"

const CAM_KEY = "panoramal.camId"
const FRAME_WIDTH = 640
const JPEG_QUALITY = 0.6
const TICK_MS = 1000
const HEARTBEAT_MS = 3000
const SETTLE_FRAMES = 2 // full frames sent 1s apart after motion stops
const MOTION_THRESHOLD = 6 // mean absolute grey difference (0–255) on a 32×24 thumbnail

// Tamper detection on the same thumbnail (no extra cost). Only "covered": very dark or flat for 3 consecutive ticks (3s).
const COVERED_MEAN = 20 // mean grey below this = lens covered / dark
const COVERED_STD = 6 // std dev below this = blurred or covered (a flat image)
const TAMPER_TICKS = 3
const TAMPER_COOLDOWN_MS = 30_000

export function tamperStats(g: Uint8ClampedArray): { mean: number; std: number } {
    let sum = 0
    for (let i = 0; i < g.length; i++) sum += g[i]
    const mean = sum / g.length
    let v = 0
    for (let i = 0; i < g.length; i++) v += (g[i] - mean) ** 2
    return { mean, std: Math.sqrt(v / g.length) }
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

// ---------- rolling video buffer ----------
// MediaRecorder on the capture stream, restarted every SEGMENT_MS so each segment is a standalone playable file.
// Keeps the last KEEP_SEGMENTS finished segments; on request, flushes the current one and uploads the last two.
const SEGMENT_MS = 10_000
const KEEP_SEGMENTS = 2
const VIDEO_BPS = 600_000

type Segment = { blob: Blob; t0: number; t1: number }

function pickMime(): string | null {
    const MR = (globalThis as any).MediaRecorder as typeof MediaRecorder | undefined
    if (!MR) return null
    for (const m of ["video/webm;codecs=vp8", "video/webm", "video/mp4"]) {
        try { if (MR.isTypeSupported(m)) return m } catch {}
    }
    return null
}

type VideoBuffer = { stop: () => void; request: (reason: string) => void }

function startVideoBuffer(stream: MediaStream, camId: string, offsetMs: number, onClip?: (n: number) => void): VideoBuffer | null {
    const mime = pickMime()
    if (!mime) return null
    const vstream = new MediaStream(stream.getVideoTracks())
    let segments: Segment[] = []
    let rec: MediaRecorder | null = null
    let segTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let uploading = false
    let flushWaiter: (() => void) | null = null

    const begin = () => {
        if (stopped) return
        let r: MediaRecorder
        try {
            r = new MediaRecorder(vstream, { mimeType: mime, videoBitsPerSecond: VIDEO_BPS })
        } catch {
            return // unsupported in practice: frames only
        }
        const chunks: Blob[] = []
        const t0 = Date.now() + offsetMs
        r.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data) }
        r.onstop = () => {
            const t1 = Date.now() + offsetMs
            if (chunks.length) {
                segments.push({ blob: new Blob(chunks, { type: chunks[0].type || mime.split(";")[0] }), t0, t1 })
                if (segments.length > KEEP_SEGMENTS) segments = segments.slice(-KEEP_SEGMENTS)
            }
            const w = flushWaiter
            flushWaiter = null
            w?.()
            begin() // next segment right away
        }
        r.onerror = () => {}
        try {
            r.start()
        } catch {
            return
        }
        rec = r
        if (segTimer) clearTimeout(segTimer)
        segTimer = setTimeout(rotate, SEGMENT_MS)
    }

    const rotate = () => {
        if (rec && rec.state !== "inactive") {
            try { rec.stop() } catch {} // onstop stores the segment and starts the next
        }
    }

    const flush = () =>
        new Promise<void>(resolve => {
            if (!rec || rec.state === "inactive") return resolve()
            const to = setTimeout(resolve, 3000)
            flushWaiter = () => { clearTimeout(to); resolve() }
            rotate()
        })

    const requestClip = async (reason: string) => {
        if (uploading || stopped) return
        uploading = true
        try {
            await flush()
            const toSend = segments.slice(-KEEP_SEGMENTS)
            let n = 0
            for (const seg of toSend) {
                const q = `cam=${encodeURIComponent(camId)}&t0=${seg.t0}&t1=${seg.t1}&reason=${encodeURIComponent(reason)}`
                try {
                    const res = await fetch(`/api/clips?${q}`, { method: "POST", headers: { "Content-Type": seg.blob.type || "video/webm" }, body: seg.blob })
                    if (res.ok) n++
                } catch {}
            }
            if (n) onClip?.(n)
        } finally {
            uploading = false
        }
    }

    begin()
    if (!rec) return null // MediaRecorder failed to start: frames only
    return {
        request: reason => void requestClip(reason).catch(() => {}),
        stop: () => {
            stopped = true
            if (segTimer) clearTimeout(segTimer)
            const r = rec
            rec = null
            try { if (r && r.state !== "inactive") r.stop() } catch {}
            segments = []
        }
    }
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
    onClip?: (n: number) => void // a clip was uploaded (n = segments sent)
}): () => void {
    const { video, camId, offsetMs } = opts
    let stream: MediaStream | null = null
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    let inFlight = false
    let lastSentAt = 0
    let lastThumb: Uint8ClampedArray | null = null
    let settleLeft = 0
    let coveredTicks = 0
    let tamperSentAt = 0
    let buffer: VideoBuffer | null = null

    // "covered" once the thumbnail has been very dark or flat for TAMPER_TICKS ticks; then a 30s cooldown.
    const checkTamper = (g: Uint8ClampedArray, now: number): "covered" | null => {
        const { mean, std } = tamperStats(g)
        coveredTicks = mean < COVERED_MEAN || std < COVERED_STD ? coveredTicks + 1 : 0
        if (coveredTicks < TAMPER_TICKS || now - tamperSentAt < TAMPER_COOLDOWN_MS) return null
        tamperSentAt = now
        return "covered"
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
            const body = (await res.json().catch(() => null)) as { clip?: { reason?: string } } | null
            if (body?.clip) buffer?.request(String(body.clip.reason ?? ""))
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
            try {
                buffer = startVideoBuffer(stream, camId, offsetMs, opts.onClip)
            } catch {
                buffer = null // no MediaRecorder: frames only
            }
            timer = setInterval(() => void tick(), TICK_MS)
        } catch (e) {
            opts.onError?.(e instanceof Error ? e : new Error(String(e)))
        }
    })()

    return () => {
        stopped = true
        if (timer) clearInterval(timer)
        buffer?.stop()
        buffer = null
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

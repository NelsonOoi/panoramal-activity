import { useEffect, useRef, useState } from "react"
import { Camera, Loader2 } from "lucide-react"
import type { CameraMeta } from "../../shared/types"
import { keepAwake, registerCamera, startCapture, syncClock } from "../lib/capture"

type Phase = "idle" | "starting" | "running" | "error"

const FONT = "Geist, Inter, system-ui, sans-serif"
const MONO = "'Geist Mono', ui-monospace, monospace"

export function Capture() {
    const video = useRef<HTMLVideoElement>(null)
    const [phase, setPhase] = useState<Phase>("idle")
    const [cam, setCam] = useState<CameraMeta | null>(null)
    const [sync, setSync] = useState<{ offsetMs: number; errMs: number } | null>(null)
    const [sent, setSent] = useState(0)
    const [lastSent, setLastSent] = useState(0)
    const [hidden, setHidden] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [now, setNow] = useState(Date.now())
    const stop = useRef<(() => void) | null>(null)

    useEffect(() => {
        const onVis = () => setHidden(document.hidden)
        document.addEventListener("visibilitychange", onVis)
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => {
            document.removeEventListener("visibilitychange", onVis)
            clearInterval(id)
            stop.current?.()
        }
    }, [])

    const start = async () => {
        if (phase === "starting") return
        setPhase("starting")
        setError(null)
        try {
            keepAwake().catch(() => {})
            const s = await syncClock()
            setSync(s)
            const meta = await registerCamera()
            setCam(meta)
            setSent(meta.observations ?? 0)
            stop.current?.()
            stop.current = startCapture({
                video: video.current!,
                camId: meta.id,
                offsetMs: s.offsetMs,
                onFrame: info => {
                    if (info.sent) {
                        setSent(n => n + 1)
                        setLastSent(Date.now())
                        setError(null)
                    }
                },
                onError: e => {
                    setError(e.message)
                    if (/permission|denied|notallowed/i.test(e.message + e.name)) setPhase("error")
                }
            })
            setLastSent(Date.now())
            setPhase("running")
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            setPhase("error")
        }
    }

    const stale = phase === "running" && now - lastSent > 6500
    const reset = !!error && /unknown camera|site was reset/i.test(error)
    const warn = hidden || stale

    return (
        <div className="relative h-full overflow-hidden bg-[#09090b] text-[#fafafa]" style={{ fontFamily: FONT }}>
            <video ref={video} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />

            {phase === "running" && cam && (
                <div className="absolute inset-x-0 top-0 flex justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))]">
                    <div className="max-w-full rounded-[8px] border border-[#27272a] bg-[#09090b]/85 px-2.5 py-1.5 text-center text-[13px] leading-snug font-medium text-[#fafafa]">
                        {warn ? (
                            "Keep this page open"
                        ) : (
                            <>
                                Witnessing as <span style={{ fontFamily: MONO }}>{cam.id}</span>
                                <span className="text-[#71717a]"> · </span>
                                <span style={{ fontFamily: MONO }}>{sent}</span> observations
                                {sync && (
                                    <>
                                        <span className="text-[#71717a]"> · </span>synced ±<span style={{ fontFamily: MONO }}>{sync.errMs}</span> ms
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}

            {phase === "running" && reset && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#09090b]/90 px-4">
                    <div className="w-full max-w-[22rem] rounded-[8px] border border-[#27272a] bg-[#09090b] p-5 text-center">
                        <div className="text-[16px] font-semibold">Unknown camera</div>
                        <div className="mt-1.5 text-[14px] leading-relaxed text-[#a1a1aa]">{error}</div>
                        <button
                            onClick={() => location.reload()}
                            className="mt-4 h-10 w-full rounded-[8px] border border-[#fafafa] bg-[#fafafa] text-[14px] font-medium text-[#09090b]"
                        >
                            Reload
                        </button>
                    </div>
                </div>
            )}

            {phase === "running" && error && !reset && !warn && (
                <div className="absolute inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] rounded-[8px] border border-[#27272a] bg-[#09090b]/85 px-3 py-2 text-center text-[13px] text-[#a1a1aa]">
                    {error}
                </div>
            )}

            {phase !== "running" && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#09090b] px-4">
                    <button
                        onClick={start}
                        className="flex w-full max-w-[22rem] flex-col items-center gap-4 rounded-[8px] border border-[#27272a] bg-[#09090b] p-6 text-center"
                    >
                        <span className="grid size-12 place-items-center rounded-[8px] border border-[#27272a] bg-[#18181b] text-[#fafafa]">
                            {phase === "starting" ? <Loader2 size={22} className="animate-spin" /> : <Camera size={22} />}
                        </span>
                        <span>
                            <span className="block text-[18px] font-semibold">
                                {phase === "starting" ? "Joining the site…" : phase === "error" ? "Camera unavailable" : "Tap to start witnessing"}
                            </span>
                            <span className="mt-1.5 block text-[14px] leading-relaxed text-[#a1a1aa]">
                                {phase === "error"
                                    ? `${error ?? "Something went wrong"}. Allow camera access and tap to try again.`
                                    : "This phone becomes one of the site's cameras. Prop it up, plug it in, and keep this page open."}
                            </span>
                        </span>
                        <span className="flex h-10 w-full items-center justify-center rounded-[8px] border border-[#fafafa] bg-[#fafafa] text-[14px] font-medium text-[#09090b]">
                            {phase === "starting" ? "Starting…" : phase === "error" ? "Try again" : "Start"}
                        </span>
                    </button>
                </div>
            )}
        </div>
    )
}

import { useEffect, useRef, useState } from "react"
import { Upload, Video } from "lucide-react"
import type { Knock } from "../../shared/types"
import { extractFrames } from "../lib/capture"

const FONT = "Geist, Inter, system-ui, sans-serif"
const MONO = "'Geist Mono', ui-monospace, monospace"

type Phase =
    | { k: "start" }
    | { k: "extracting"; p: number; frames: number }
    | { k: "waiting" }
    | { k: "approved" }
    | { k: "done"; message: string | null }
    | { k: "denied" }
    | { k: "error"; message: string }

function videoDuration(file: File): Promise<number> {
    return new Promise(resolve => {
        const v = document.createElement("video")
        v.preload = "metadata"
        v.muted = true
        const url = URL.createObjectURL(file)
        const done = (ms: number) => {
            URL.revokeObjectURL(url)
            resolve(ms)
        }
        v.onloadedmetadata = () => done(isFinite(v.duration) ? Math.round(v.duration * 1000) : 0)
        v.onerror = () => done(0)
        setTimeout(() => done(0), 8000)
        v.src = url
    })
}

export function Witness() {
    const [phase, setPhase] = useState<Phase>({ k: "start" })
    const [guestId, setGuestId] = useState<string | null>(null)
    const fileRef = useRef<HTMLInputElement>(null)

    // Poll the knock until it's settled.
    useEffect(() => {
        if (!guestId || !["waiting", "approved"].includes(phase.k)) return
        let stopped = false
        const poll = async () => {
            try {
                const r = await fetch(`/api/witness/${encodeURIComponent(guestId)}`)
                if (r.ok) {
                    const k = (await r.json()) as Knock
                    if (stopped) return
                    if (k.status === "approved") setPhase(p => (p.k === "approved" ? p : { k: "approved" }))
                    else if (k.status === "done") setPhase({ k: "done", message: k.message })
                    else if (k.status === "denied") setPhase({ k: "denied" })
                }
            } catch {}
        }
        poll()
        const id = setInterval(poll, 1500)
        return () => {
            stopped = true
            clearInterval(id)
        }
    }, [guestId, phase.k])

    const upload = async (file: File) => {
        try {
            setPhase({ k: "extracting", p: 0, frames: 0 })
            const r = await fetch("/api/witness", { method: "POST" })
            if (!r.ok) throw new Error(`The site didn't respond (${r.status})`)
            const { guestId } = (await r.json()) as { guestId: string }
            setGuestId(guestId)
            const knownMs = await videoDuration(file)
            const startedAt = (file.lastModified || Date.now()) - knownMs
            let frames = 0
            const { durationMs } = await extractFrames(file, {
                fps: 1,
                onFrame: async (jpeg, clipMs) => {
                    await fetch(`/api/witness/${encodeURIComponent(guestId)}/frame?t=${Math.round(startedAt + clipMs)}`, {
                        method: "POST",
                        headers: { "content-type": "image/jpeg" },
                        body: jpeg
                    })
                    frames++
                    setPhase(p => (p.k === "extracting" ? { ...p, frames } : p))
                },
                onProgress: p => setPhase(prev => (prev.k === "extracting" ? { ...prev, p } : prev))
            })
            const dur = durationMs || knownMs
            const start = knownMs ? startedAt : (file.lastModified || Date.now()) - dur
            const d = await fetch(`/api/witness/${encodeURIComponent(guestId)}/done`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ startedAt: start, durationMs: dur })
            })
            if (!d.ok) throw new Error(`Upload couldn't finish (${d.status})`)
            setPhase({ k: "waiting" })
        } catch (e) {
            setPhase({ k: "error", message: e instanceof Error ? e.message : String(e) })
        }
    }

    return (
        <div
            className="relative flex h-full flex-col overflow-y-auto bg-[#09090b] px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] text-[#fafafa]"
            style={{ fontFamily: FONT }}
        >
            <div className="flex items-center gap-2.5">
                <img src="/favicon.svg" alt="" width="24" height="24" />
                <span className="text-[15px] font-semibold">Panoramal Activity</span>
            </div>
            <input
                ref={fileRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) upload(f)
                    e.target.value = ""
                }}
            />
            <div className="flex flex-1 flex-col justify-center py-8">
                {phase.k === "start" && (
                    <>
                        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Saw something?</h1>
                        <p className="mt-2 text-[15px] leading-relaxed text-[#a1a1aa]">Add your footage to the investigation. Your phone joins as a witness, and the site decides whether to accept it.</p>
                        <div className="mt-6 flex flex-col gap-3">
                            <Choice icon={<Upload size={20} />} title="Upload a clip" sub="Pick a video from your camera roll" onClick={() => fileRef.current?.click()} />
                            <Choice icon={<Video size={20} />} title="Record now" sub="Use this phone as a live camera" onClick={() => (location.href = "/capture")} />
                        </div>
                    </>
                )}
                {phase.k === "extracting" && (
                    <Card>
                        <Title>Reading your clip</Title>
                        <Bar p={phase.p} />
                        <Sub>
                            <span style={{ fontFamily: MONO }}>{Math.round(Math.min(1, Math.max(0, phase.p)) * 100)}%</span> ·{" "}
                            <span style={{ fontFamily: MONO }}>{phase.frames}</span> frames sent · one per second
                        </Sub>
                    </Card>
                )}
                {phase.k === "waiting" && (
                    <Card>
                        <Title>Asking the site to accept your footage…</Title>
                        <Sub>Your phone has knocked. The operator will let it in.</Sub>
                        <Skeleton />
                    </Card>
                )}
                {phase.k === "approved" && (
                    <Card>
                        <Title>Analysing…</Title>
                        <Sub>You're in. Your clip is being questioned alongside the site's cameras.</Sub>
                        <Skeleton />
                    </Card>
                )}
                {phase.k === "done" && (
                    <Card>
                        <Title>Thank you</Title>
                        <p className="text-[15px] leading-relaxed">{phase.message ?? "Your clip has been added to the case."}</p>
                    </Card>
                )}
                {phase.k === "denied" && (
                    <Card>
                        <Title>Not needed this time</Title>
                        <Sub>The site didn't add this clip. Thanks for offering.</Sub>
                    </Card>
                )}
                {phase.k === "error" && (
                    <Card>
                        <Title>That didn't work</Title>
                        <Sub>{phase.message}</Sub>
                        <button onClick={() => setPhase({ k: "start" })} className="mt-2 h-10 rounded-[8px] border border-[#fafafa] bg-[#fafafa] text-[14px] font-medium text-[#09090b]">
                            Try again
                        </button>
                    </Card>
                )}
            </div>
        </div>
    )
}

function Choice({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) {
    return (
        <button onClick={onClick} className="flex items-center gap-4 rounded-[8px] border border-[#27272a] bg-transparent p-4 text-left active:bg-[#18181b]">
            <span className="grid size-11 shrink-0 place-items-center rounded-[6px] border border-[#27272a] bg-[#18181b] text-[#fafafa]">{icon}</span>
            <span>
                <span className="block text-[16px] font-semibold">{title}</span>
                <span className="block text-[14px] text-[#a1a1aa]">{sub}</span>
            </span>
        </button>
    )
}

function Card({ children }: { children: React.ReactNode }) {
    return <div className="flex flex-col gap-3 rounded-[8px] border border-[#27272a] bg-[#09090b] p-5">{children}</div>
}
function Title({ children }: { children: React.ReactNode }) {
    return <h2 className="text-[18px] leading-tight font-semibold">{children}</h2>
}
function Sub({ children }: { children: React.ReactNode }) {
    return <p className="text-[14px] leading-relaxed text-[#a1a1aa]">{children}</p>
}

function Bar({ p }: { p: number }) {
    const pct = Math.round(Math.min(1, Math.max(0, p)) * 100)
    return (
        <div className="h-2 w-full overflow-hidden rounded-[6px] bg-[#27272a]">
            <div className="h-full rounded-[6px] bg-[#fafafa] transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
    )
}

function Skeleton() {
    return (
        <div className="flex flex-col gap-2">
            <div className="h-3 w-full rounded-[6px] bg-[#27272a]" />
            <div className="h-3 w-2/3 rounded-[6px] bg-[#18181b]" />
        </div>
    )
}

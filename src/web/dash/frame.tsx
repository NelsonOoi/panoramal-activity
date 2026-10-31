import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { Person } from "../../shared/types"
import { cn } from "../ui"

// Sidecar next to each stored frame: /frames/<cam>/<t>.json → { people }.
const sidecars = new Map<string, Promise<Person[] | null>>()
export function sidecarUrl(frameRef: string) {
    const url = frameRef.replace(/\.(jpe?g|png|svg|webp)(\?.*)?$/i, ".json")
    return url === frameRef ? null : url
}
export function loadSidecar(frameRef: string): Promise<Person[] | null> {
    let p = sidecars.get(frameRef)
    if (!p) {
        const url = sidecarUrl(frameRef)
        p = !url
            ? Promise.resolve(null)
            : fetch(url)
                  .then(r => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null))
                  .then(v => (v && Array.isArray(v.people) ? (v.people as Person[]) : null))
                  .catch(() => null)
        sidecars.set(frameRef, p)
        if (sidecars.size > 400) sidecars.delete(sidecars.keys().next().value!)
    }
    return p
}

export function useSidecar(frameRef: string | undefined, given?: Person[]): Person[] | null {
    const [people, setPeople] = useState<Person[] | null>(given ?? null)
    useEffect(() => {
        if (given) {
            setPeople(given)
            return
        }
        if (!frameRef) {
            setPeople(null)
            return
        }
        let live = true
        loadSidecar(frameRef).then(p => live && setPeople(p))
        return () => {
            live = false
        }
    }, [frameRef, given])
    return people
}

// Preload the next frame before swapping so the tile never flashes empty.
function usePreloaded(src: string | undefined) {
    const [shown, setShown] = useState<{ src: string; w: number; h: number } | null>(null)
    useEffect(() => {
        if (!src) {
            setShown(null)
            return
        }
        let live = true
        const img = new Image()
        img.onload = () => live && setShown({ src, w: img.naturalWidth || 16, h: img.naturalHeight || 9 })
        img.onerror = () => live && setShown(s => s ?? { src, w: 16, h: 9 })
        img.src = src
        return () => {
            live = false
        }
    }, [src])
    return shown
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
    const [size, setSize] = useState({ w: 0, h: 0 })
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
        ro.observe(el)
        setSize({ w: el.clientWidth, h: el.clientHeight })
        return () => ro.disconnect()
    }, [ref])
    return size
}

// A 16:9 scene. The image is fitted inside it and the boxes sit on the image itself.
export function Scene({
    frameRef,
    people,
    labels = true,
    dim,
    className,
    empty
}: {
    frameRef?: string
    people?: Person[] | null
    labels?: boolean
    dim?: boolean
    className?: string
    empty?: React.ReactNode
}) {
    const ref = useRef<HTMLDivElement>(null)
    const box = useSize(ref)
    const img = usePreloaded(frameRef)
    let fw = 0
    let fh = 0
    if (img && box.w && box.h) {
        const r = Math.min(box.w / img.w, box.h / img.h)
        fw = img.w * r
        fh = img.h * r
    }
    return (
        <div ref={ref} className={cn("relative aspect-video overflow-hidden rounded-md border border-border bg-scene", className)}>
            {img && fw > 0 ? (
                <div className={cn("absolute", dim && "opacity-45")} style={{ width: fw, height: fh, left: (box.w - fw) / 2, top: (box.h - fh) / 2 }}>
                    <img src={img.src} alt="" className="block size-full" draggable={false} />
                    {(people ?? []).map((p, i) => (
                        <div
                            key={`${p.id}-${i}`}
                            className="absolute rounded-[3px] border-[1.5px] border-[#fafafa]"
                            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}
                        >
                            {labels && (
                                <span
                                    className={cn(
                                        "absolute left-[-1.5px] rounded px-1.5 py-px text-[11px] font-medium whitespace-nowrap text-[#09090b] bg-[#fafafa]",
                                        p.y < 0.08 ? "top-0" : "top-[-21px]"
                                    )}
                                >
                                    {p.id} · {p.desc}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                empty && <div className="absolute inset-0 grid place-items-center text-[13px] text-subtle">{empty}</div>
            )}
        </div>
    )
}

export function Thumb({ frameRef, className, dashed }: { frameRef?: string; className?: string; dashed?: boolean }) {
    return (
        <span className={cn("block overflow-hidden rounded border border-border bg-scene", dashed && "border-dashed bg-transparent", className)}>
            {frameRef && <img src={frameRef} alt="" loading="lazy" className="block size-full object-cover" draggable={false} />}
        </span>
    )
}

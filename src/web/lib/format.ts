import { useEffect, useState } from "react"

export function clock(t: number): string {
    const d = new Date(t)
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

export function relative(t: number, now: number): string {
    const s = Math.max(0, Math.round((now - t) / 1000))
    if (s < 5) return "now"
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    return clock(t)
}

export function seconds(ms: number): string {
    const s = ms / 1000
    return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

export function useNow(intervalMs = 1000): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(id)
    }, [intervalMs])
    return now
}

export function shortId(id: string): string {
    return id
}

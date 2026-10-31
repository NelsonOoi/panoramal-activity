import type { Clip } from "../../shared/types"

// Thin HTTP helpers. In replay/mock mode, actions are no-ops so a recorded run can't touch the live site.
let inert = false
export function setInert(v: boolean) {
    inert = v
}
export function isInert() {
    return inert
}

export async function getJSON<T>(url: string): Promise<T> {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`${url} → ${r.status}`)
    return r.json() as Promise<T>
}

export async function postJSON<T = unknown>(url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!r.ok) throw new Error(`${url} → ${r.status}`)
    const text = await r.text()
    return (text ? JSON.parse(text) : {}) as T
}

// Actions the operator takes from the dashboard.
export async function action<T = unknown>(url: string, body?: unknown): Promise<T | null> {
    if (inert) {
        console.info("[inert]", url, body)
        return null
    }
    try {
        return await postJSON<T>(url, body)
    } catch (e) {
        console.error(e)
        return null
    }
}

let configPromise: Promise<{ publicUrl: string }> | null = null
export function getConfig(): Promise<{ publicUrl: string }> {
    if (!configPromise) {
        configPromise = getJSON<{ publicUrl: string }>("/api/config")
            .then(c => ({ publicUrl: (c.publicUrl || location.origin).replace(/\/$/, "") }))
            .catch(() => ({ publicUrl: location.origin }))
    }
    return configPromise
}

// Clips overlapping [t0, t1] (optionally one camera). Inert or failing → [] so mock/replay relies on clip events.
export async function getClips(t0: number, t1: number, cam?: string): Promise<Clip[]> {
    if (inert) return []
    const q = new URLSearchParams({ t0: String(Math.floor(t0)), t1: String(Math.ceil(t1)) })
    if (cam) q.set("cam", cam)
    try {
        const r = await getJSON<Clip[]>(`/api/clips?${q}`)
        return Array.isArray(r) ? r : []
    } catch {
        return []
    }
}

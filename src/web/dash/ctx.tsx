import { createContext, useContext } from "react"
import type { CameraMeta, Citation } from "../../shared/types"
import { clock } from "../lib/format"

export interface FrameAt {
    t: number
    frameRef: string
}

export interface DashCtx {
    cameras: Record<string, CameraMeta>
    openCamera: (camId: string, at?: FrameAt) => void
}

export const Ctx = createContext<DashCtx>({ cameras: {}, openCamera: () => {} })
export const useDash = () => useContext(Ctx)

export function agentName(raw: string) {
    return raw.replace(/^[@#]/, "")
}

export function CitationChip({ c }: { c: Citation }) {
    const { openCamera } = useDash()
    return (
        <button
            type="button"
            onClick={() => openCamera(c.camId, { t: c.t, frameRef: c.frameRef })}
            className="cursor-pointer rounded-md border border-border px-[7px] py-px font-mono text-xs text-muted-fg hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
            {c.camId} {clock(c.t)}
        </button>
    )
}

export function statusOf(c: CameraMeta): { label: string; variant: "outline" | "secondary" } {
    if (c.kind === "upload") return { label: "Guest clip", variant: "secondary" }
    if (!c.online) return { label: "Offline · memory kept", variant: "outline" }
    return { label: "Live", variant: "outline" }
}

import { Plus } from "lucide-react"
import type { SourceStatus } from "../lib/source"
import { Button, Logo } from "../ui"

export { Logo }

const NOTE: Partial<Record<SourceStatus, string>> = {
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    error: "Can't reach the site",
    mock: "Mock run",
    replay: "Recorded run",
    "replay-done": "Recorded run"
}

export function Header({
    status,
    cameras,
    online,
    busy,
    onNew,
    onQuick
}: {
    status: SourceStatus
    cameras: number
    online: number
    busy: boolean
    onNew: () => void
    onQuick: () => void
}) {
    const note = NOTE[status]
    return (
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
            <div className="flex grow items-center gap-2.5 font-semibold">
                <Logo />
                Panoramal Activity
                <div className="h-5 w-px bg-border" aria-hidden />
                <span className="font-normal text-muted-fg">
                    {online} of {cameras} cameras live
                </span>
                {note && <span className="font-normal text-subtle">· {note}</span>}
            </div>
            <Button onClick={onNew}>
                <Plus size={16} />
                New incident
            </Button>
            <Button variant="primary" onClick={onQuick} disabled={busy}>
                What just happened?
            </Button>
        </header>
    )
}

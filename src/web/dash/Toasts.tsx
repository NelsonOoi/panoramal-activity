import { useEffect, useState } from "react"
import { CameraOff, DoorOpen, Loader2, PackageOpen, PackageX, TriangleAlert, Users } from "lucide-react"
import type { Alert, AlertKind, Knock } from "../../shared/types"
import { clock, useNow } from "../lib/format"
import { Badge, Button, CloseButton, cn } from "../ui"

export const KIND_LABEL: Record<AlertKind, string> = {
    "object-gone": "Object gone",
    "object-left": "Object left",
    crowd: "Crowd change",
    tamper: "Camera tampered",
    notable: "Notable"
}
const KIND_ICON: Record<AlertKind, typeof PackageX> = {
    "object-gone": PackageX,
    "object-left": PackageOpen,
    crowd: Users,
    tamper: CameraOff,
    notable: TriangleAlert
}

export function Toasts({
    alerts,
    knocks,
    onAck,
    onInvestigate,
    onDismissAlert,
    onKnock,
    onDismissKnock
}: {
    alerts: Alert[]
    knocks: Knock[]
    onAck: (a: Alert) => void
    onInvestigate: (a: Alert) => void
    onDismissAlert: (id: string) => void
    onKnock: (guestId: string, ok: boolean) => void
    onDismissKnock: (guestId: string) => void
}) {
    // Newest on top, stacked from the bottom-left corner.
    return (
        <div className="fixed bottom-4 left-4 z-40 flex w-[min(400px,calc(100vw-32px))] flex-col gap-2.5" aria-live="polite">
            {[...alerts].reverse().map(a => (
                <AlertToast key={`a-${a.id}`} a={a} onAck={onAck} onInvestigate={onInvestigate} onDismiss={onDismissAlert} />
            ))}
            {knocks.map(k => (
                <KnockToast key={`k-${k.guestId}`} k={k} onKnock={onKnock} onDismiss={onDismissKnock} />
            ))}
        </div>
    )
}

function Shell({ done, icon, children }: { done?: boolean; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div
            className={cn(
                "flex animate-toast-in gap-3 rounded-[10px] border border-border bg-background px-3.5 pt-3.5 pb-3 shadow-[0_4px_12px_rgba(0,0,0,0.4)]",
                done && "opacity-70"
            )}
        >
            <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-fg">{icon}</div>
            <div className="min-w-0 grow">{children}</div>
        </div>
    )
}

// escalateAt === 0 marks a notify-only alert (crowd, model-flagged notable): no countdown, never escalates.
const notifyOnly = (a: Alert) => !a.escalateAt

function statusText(a: Alert): string | null {
    if (a.status === "acknowledged") return notifyOnly(a) ? "Acknowledged" : "Acknowledged · escalation cancelled"
    if (a.status === "investigating") return `Investigating${a.incId ? ` · ${a.incId}` : ""}`
    if (a.status === "escalated") return "Escalated: no response in 30s. Investigation started."
    return null
}

function AlertToast({ a, onAck, onInvestigate, onDismiss }: { a: Alert; onAck: (a: Alert) => void; onInvestigate: (a: Alert) => void; onDismiss: (id: string) => void }) {
    const now = useNow(250)
    const [sent, setSent] = useState<null | "ack" | "inv">(null)
    const done = statusText(a)
    useEffect(() => {
        if (!done) return
        const id = setTimeout(() => onDismiss(a.id), 6000)
        return () => clearTimeout(id)
    }, [done, a.id, onDismiss])
    const raisedAt = a.history?.find(h => h.status === "raised")?.at ?? a.t
    const total = Math.max(1000, Math.min(60000, a.escalateAt - raisedAt) || 30000)
    const leftMs = Math.max(0, a.escalateAt - now)
    const Icon = KIND_ICON[a.kind] ?? TriangleAlert
    return (
        <Shell done={!!done} icon={<Icon size={16} />}>
            <div className="flex items-center justify-between gap-2">
                <Badge variant={done ? "outline" : "destructive"}>{KIND_LABEL[a.kind] ?? "Notable"}</Badge>
                <span className="font-mono text-xs text-muted-fg">
                    {a.camId} · {clock(a.t)}
                </span>
            </div>
            <div className="mt-1.5 font-medium">{a.text}</div>
            <div className="text-xs text-muted-fg">
                {done ?? (notifyOnly(a) ? "Notification only" : leftMs > 0 ? `Auto-investigates in ${Math.ceil(leftMs / 1000)}s` : "Escalating…")}
            </div>
            {!done && !notifyOnly(a) && (
                <div className="mt-2.5 h-0.5 overflow-hidden rounded-sm bg-muted">
                    <i className="block h-full origin-left bg-muted-fg transition-transform duration-200 ease-linear" style={{ transform: `scaleX(${leftMs / total})` }} />
                </div>
            )}
            <div className="mt-2.5 flex items-center gap-2">
                {!done && (
                    <>
                        <Button
                            size="sm"
                            disabled={sent !== null}
                            onClick={() => {
                                setSent("ack")
                                onAck(a)
                            }}
                        >
                            {sent === "ack" && <Loader2 size={14} className="animate-spin" />}
                            Acknowledge
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={sent !== null}
                            onClick={() => {
                                setSent("inv")
                                onInvestigate(a)
                            }}
                        >
                            {sent === "inv" && <Loader2 size={14} className="animate-spin" />}
                            Investigate
                        </Button>
                    </>
                )}
                <CloseButton
                    small
                    label="Dismiss"
                    onClick={() => {
                        // A notify-only alert stays "raised" on the server until acknowledged, so dismissing acknowledges it.
                        if (!done && notifyOnly(a) && sent === null) onAck(a)
                        onDismiss(a.id)
                    }}
                />
            </div>
        </Shell>
    )
}

function knockText(k: Knock): string {
    switch (k.status) {
        case "uploading":
            return "is sending footage…"
        case "waiting":
            return "wants to add footage"
        case "approved":
            return "was approved · clip added to the case"
        case "denied":
            return "was turned away"
        case "done":
            return "footage reviewed"
    }
}

function KnockToast({ k, onKnock, onDismiss }: { k: Knock; onKnock: (guestId: string, ok: boolean) => void; onDismiss: (guestId: string) => void }) {
    const [sent, setSent] = useState<null | boolean>(null)
    const settled = k.status === "approved" || k.status === "denied" || k.status === "done"
    useEffect(() => {
        if (!settled) return
        const id = setTimeout(() => onDismiss(k.guestId), 6000)
        return () => clearTimeout(id)
    }, [settled, k.guestId, onDismiss])
    return (
        <Shell done={settled} icon={<DoorOpen size={16} />}>
            <div className="flex items-center justify-between gap-2">
                <Badge>Knock</Badge>
                <span className="font-mono text-xs text-muted-fg">{k.guestId}</span>
            </div>
            <div className="mt-1.5 font-medium">
                {k.guestId} {knockText(k)}
            </div>
            <div className="font-mono text-xs text-muted-fg">{k.offer}</div>
            {k.status === "done" && k.message && <div className="mt-1 text-xs text-muted-fg">{k.message}</div>}
            <div className="mt-2.5 flex items-center gap-2">
                {k.status === "uploading" && <Loader2 size={14} className="animate-spin text-muted-fg" />}
                {k.status === "waiting" && (
                    <>
                        <Button
                            size="sm"
                            disabled={sent !== null}
                            onClick={() => {
                                setSent(false)
                                onKnock(k.guestId, false)
                            }}
                        >
                            Deny
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={sent !== null}
                            onClick={() => {
                                setSent(true)
                                onKnock(k.guestId, true)
                            }}
                        >
                            {sent === true && <Loader2 size={14} className="animate-spin" />}
                            Approve
                        </Button>
                    </>
                )}
                <CloseButton small label="Dismiss" onClick={() => onDismiss(k.guestId)} />
            </div>
        </Shell>
    )
}

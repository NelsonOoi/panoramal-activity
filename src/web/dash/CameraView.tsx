import { useCallback, useEffect, useMemo, useState } from "react"
import { RotateCcw } from "lucide-react"
import type { AskResult, CameraMeta, Observation, Person } from "../../shared/types"
import { clock } from "../lib/format"
import { Badge, Button, Dialog, DialogHeader, Input, Label, Panel, Skeleton, cn } from "../ui"
import { type FrameAt, CitationChip, statusOf } from "./ctx"
import { Scene, Thumb, useSidecar } from "./frame"

export interface CameraApi {
    recent: (camId: string) => Promise<Observation[]>
    ask: (camId: string, question: string) => Promise<AskResult>
}

interface Run {
    key: string
    newest: Observation
    oldest: Observation
    count: number
    text: string
    notable: string | null
}

const sig = (o: Observation) =>
    o.people
        .map(p => `${p.id}:${p.action}`)
        .sort()
        .join(",") + `|${o.notable ?? ""}`

const describe = (o: Observation) => (o.people.length ? o.people.map(p => `${p.id} · ${p.action || p.desc}`).join("; ") : "Nobody in view")

// Newest first; consecutive frames with the same people (ids + actions) and notable fold into one row.
function collapse(obs: Observation[]): Run[] {
    const out: Run[] = []
    for (const o of obs) {
        const last = out[out.length - 1]
        if (last && sig(last.newest) === sig(o)) {
            last.oldest = o
            last.count++
        } else out.push({ key: `${o.camId}-${o.t}`, newest: o, oldest: o, count: 1, text: describe(o), notable: o.notable })
    }
    return out
}

export function CameraView({
    camera,
    at,
    lastN,
    api,
    onClose
}: {
    camera: CameraMeta | null
    at?: FrameAt
    lastN: number // bumps on each new observation for this camera
    api: CameraApi
    onClose: () => void
}) {
    return (
        <Dialog open={!!camera} onClose={onClose} labelledBy="cam-title">
            {camera && <Body key={camera.id} camera={camera} at={at} lastN={lastN} api={api} onClose={onClose} />}
        </Dialog>
    )
}

function Body({ camera, at, lastN, api, onClose }: { camera: CameraMeta; at?: FrameAt; lastN: number; api: CameraApi; onClose: () => void }) {
    const [obs, setObs] = useState<Observation[] | null>(null)
    const [loadErr, setLoadErr] = useState(false)
    const [sel, setSel] = useState<FrameAt | null>(at ?? null)
    useEffect(() => setSel(at ?? null), [at])

    // Refresh while open, at most every 3s.
    const [tick, setTick] = useState(0)
    useEffect(() => {
        const id = setInterval(() => setTick(x => x + 1), 3000)
        return () => clearInterval(id)
    }, [])
    useEffect(() => {
        let live = true
        api.recent(camera.id)
            .then(o => {
                if (!live) return
                setObs(o)
                setLoadErr(false)
            })
            .catch(() => live && setLoadErr(true))
        return () => {
            live = false
        }
        // lastN is read only through tick so frames don't refetch faster than 3s
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [camera.id, tick])
    void lastN

    const runs = useMemo(() => collapse(obs ?? []), [obs])
    const latest = obs?.[0]
    const shown: FrameAt | null = sel ?? (latest ? { t: latest.t, frameRef: latest.frameRef } : null)
    const shownObs = shown ? obs?.find(o => o.frameRef === shown.frameRef) : undefined
    const sidecar = useSidecar(shownObs ? undefined : shown?.frameRef, shownObs?.people)
    const people: Person[] = shownObs?.people ?? sidecar ?? []
    const isLatest = !!latest && shown?.frameRef === latest.frameRef
    const notable = obs?.find(o => o.notable)
    const st = statusOf(camera)
    const off = !camera.online && camera.kind !== "upload"

    return (
        <>
            <DialogHeader
                id="cam-title"
                title={camera.id}
                extra={<Badge variant={st.variant}>{st.label}</Badge>}
                description={`${camera.observations} observations`}
                onClose={onClose}
            />
            <div className="flex flex-wrap gap-[18px] px-[22px] pt-[18px] pb-[22px]">
                <div className="flex min-w-0 flex-[999_1_540px] flex-col gap-3.5">
                    <Scene frameRef={shown?.frameRef} people={people} className="max-h-[60vh] w-full" dim={off && isLatest} empty={loadErr ? "Memory unavailable" : obs ? "No frames yet" : "Loading…"} />
                    <div className="flex items-center justify-between">
                        <Label>Frame</Label>
                        <span className="font-mono text-xs text-muted-fg">{shown ? `${clock(shown.t)}${isLatest ? " · latest" : ""}` : ""}</span>
                    </div>
                    <Ask camId={camera.id} api={api} />
                </div>
                <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-3.5">
                    <Panel>
                        <Label className="mb-2">In view now</Label>
                        <div className="flex flex-col gap-2">
                            {latest?.people.length ? (
                                latest.people.map((p, i) => (
                                    <div key={`${p.id}-${i}`} className="flex items-start gap-2">
                                        <Badge>{p.id}</Badge>
                                        <div className="min-w-0">
                                            <div>{p.desc}</div>
                                            <div className="text-[13px] text-muted-fg">{p.action}</div>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="text-muted-fg">{obs ? "Nobody in view" : "…"}</div>
                            )}
                        </div>
                        <Label className="mt-3.5 mb-1">Objects</Label>
                        <div className="text-muted-fg">
                            {latest?.objects.length ? latest.objects.map(o => (o.heldBy ? `${o.label} (held by ${o.heldBy})` : o.label)).join(", ") : "None"}
                        </div>
                        {notable && (
                            <div className="mt-3 flex items-start gap-2">
                                <Badge variant="solid">Notable</Badge>
                                <span>
                                    {notable.notable} <span className="font-mono text-xs text-subtle">{clock(notable.t)}</span>
                                </span>
                            </div>
                        )}
                    </Panel>
                    <Panel>
                        <div className="mb-1.5 flex items-center justify-between">
                            <Label>Recent log</Label>
                            <span className="text-[13px] text-muted-fg">Newest first</span>
                        </div>
                        <div className="scroll-thin flex max-h-[300px] flex-col overflow-auto">
                            {obs && runs.length === 0 && <div className="py-1 text-[13px] text-muted-fg">Nothing remembered yet.</div>}
                            {loadErr && !obs && <div className="py-1 text-[13px] text-muted-fg">Couldn't load this camera's memory.</div>}
                            {!obs && !loadErr && (
                                <div className="flex flex-col gap-2 py-1">
                                    <Skeleton className="w-4/5" />
                                    <Skeleton className="w-3/5" />
                                </div>
                            )}
                            {runs.map(r => {
                                const selected = shown?.frameRef === r.newest.frameRef
                                return (
                                    <button
                                        key={r.key}
                                        type="button"
                                        onClick={() => setSel({ t: r.newest.t, frameRef: r.newest.frameRef })}
                                        className={cn(
                                            "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                                            selected && "bg-secondary hover:bg-secondary"
                                        )}
                                    >
                                        <Thumb frameRef={r.newest.frameRef} className="h-[30px] w-[52px] shrink-0" />
                                        <span className="min-w-0 grow">
                                            <span className={cn("block truncate", r.notable ? "font-medium" : "text-muted-fg")}>
                                                {r.notable ? `${r.text} · ${r.notable}` : r.text}
                                            </span>
                                            <span className="block truncate font-mono text-xs text-subtle">
                                                {r.count > 1 ? `${clock(r.oldest.t)}–${clock(r.newest.t)} · ${r.count} frames` : clock(r.newest.t)}
                                            </span>
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    </Panel>
                </div>
            </div>
        </>
    )
}

type AskState = { k: "idle" } | { k: "pending"; q: string } | { k: "done"; q: string; r: AskResult } | { k: "error"; q: string; msg: string }

function Ask({ camId, api }: { camId: string; api: CameraApi }) {
    const [q, setQ] = useState("")
    const [st, setSt] = useState<AskState>({ k: "idle" })
    const placeholder = "What did you see in the last 10 minutes?"
    const run = useCallback(
        (question: string) => {
            setSt({ k: "pending", q: question })
            api.ask(camId, question)
                .then(r => setSt({ k: "done", q: question, r }))
                .catch((e: Error) => setSt({ k: "error", q: question, msg: e.message }))
        },
        [api, camId]
    )
    return (
        <Panel>
            <Label className="mb-2">Ask this camera</Label>
            <form
                className="flex items-center gap-2"
                onSubmit={e => {
                    e.preventDefault()
                    if (st.k === "pending") return
                    run(q.trim() || placeholder)
                }}
            >
                <label htmlFor="ask-input" className="sr-only">
                    Question for this camera
                </label>
                <Input id="ask-input" value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} autoFocus />
                <Button type="submit" variant="primary" disabled={st.k === "pending"}>
                    Ask
                </Button>
            </form>
            {st.k !== "idle" && <div className="mt-3 mb-1.5 text-[13px] text-muted-fg">You asked: {st.q}</div>}
            {st.k === "pending" && (
                <div className="flex flex-col gap-1.5">
                    <Skeleton className="w-[90%]" />
                    <Skeleton className="w-[60%]" />
                </div>
            )}
            {st.k === "done" && (
                <>
                    <div className="leading-relaxed">{st.r.text}</div>
                    {st.r.claims.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                            {st.r.claims.map((c, i) => (
                                <CitationChip key={`${c.t}-${i}`} c={{ camId, t: c.t, frameRef: c.frameRef }} />
                            ))}
                        </div>
                    )}
                </>
            )}
            {st.k === "error" && (
                <div className="flex items-center gap-3">
                    <div className="min-w-0 grow">
                        <div className="font-medium">Camera couldn't answer</div>
                        <div className="truncate text-[13px] text-muted-fg">{st.msg}</div>
                    </div>
                    <Button size="sm" onClick={() => run(st.q)}>
                        <RotateCcw size={14} />
                        Retry
                    </Button>
                </div>
            )}
        </Panel>
    )
}

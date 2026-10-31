import { Fragment } from "react"
import type { IncidentState, PathPoint } from "../../shared/types"
import { clock, seconds } from "../lib/format"
import { Badge, Card, CardContent, CardHeader, Label, Panel, Skeleton, cn } from "../ui"
import { CitationChip, useDash } from "./ctx"
import { Thumb } from "./frame"

const STATUS: Record<IncidentState["status"], { label: string; variant: "outline" | "secondary" }> = {
    gathering: { label: "Gathering", variant: "secondary" },
    analysing: { label: "Analysing", variant: "secondary" },
    done: { label: "Complete", variant: "outline" }
}

export function CaseFile({ incident, className }: { incident: IncidentState | null; className?: string }) {
    if (!incident)
        return (
            <Card className={className}>
                <CardHeader title="Case file" description="No open incident" />
                <CardContent>
                    <div className="text-[13px] text-muted-fg">
                        Press “What just happened?” or start a new incident. An alert nobody answers opens one by itself.
                    </div>
                </CardContent>
            </Card>
        )
    const inc = incident
    const st = STATUS[inc.status] ?? STATUS.gathering
    const pending = inc.witnesses.filter(w => w.status === "asked")
    const showWitnesses = inc.status !== "done" && (pending.length > 0 || inc.timeline.length === 0)
    const rows = inc.timeline.length === 0 ? inc.witnesses : pending
    const resolved = inc.contradictions.filter(c => c.resolution)
    const open = inc.contradictions.filter(c => !c.resolution)
    return (
        <Card className={className}>
            <CardHeader
                title={inc.question}
                description={
                    <span className="font-mono text-xs">
                        {inc.id} · {clock(inc.window[0])}–{clock(inc.window[1])} · {inc.witnesses.length} cameras
                    </span>
                }
                right={<Badge variant={st.variant}>{st.label}</Badge>}
            />
            <CardContent className="scroll-thin min-h-0 flex-1 overflow-auto">
                {showWitnesses && (
                    <div className="flex flex-col gap-2.5">
                        {rows.map(w => (
                            <div key={w.camId} className="flex items-center gap-2">
                                <span className="w-[90px] shrink-0 truncate font-medium">{w.camId}</span>
                                <span className="w-[140px] shrink-0 text-[13px] text-muted-fg">
                                    {w.status === "asked" ? "Searching memory…" : w.status === "answered" ? "Answered" : "No answer"}
                                </span>
                                {w.status === "asked" && <Skeleton className="grow" />}
                            </div>
                        ))}
                        {inc.timeline.length === 0 && <div className="text-[13px] text-muted-fg">Cameras answer over Relay. The storyboard, timeline and verdict fill in here.</div>}
                    </div>
                )}

                {inc.paths.map(p => (
                    <Panel key={p.entityId}>
                        <div className="mb-2.5 flex items-center justify-between gap-2">
                            <Label className="truncate">
                                {p.entityId} · {p.desc}
                            </Label>
                            <span className="text-[13px] text-muted-fg">Storyboard</span>
                        </div>
                        <Storyboard points={p.points} windowEnd={inc.window[1]} />
                    </Panel>
                ))}

                {inc.timeline.length > 0 && (
                    <div className="flex flex-col gap-3">
                        {[...inc.timeline]
                            .sort((a, b) => a.t - b.t)
                            .map(it => (
                                <div key={it.id} className="flex gap-3.5">
                                    <div className="w-[60px] shrink-0 pt-0.5 font-mono text-xs text-muted-fg">{clock(it.t)}</div>
                                    <div className={cn("min-w-0 grow", it.inferred && "text-muted-fg")}>
                                        {it.revisedFrom && (
                                            <div className="mb-0.5 flex items-start gap-2">
                                                <Badge>Revised</Badge>
                                                <span className="text-[13px] text-subtle line-through">{it.revisedFrom}</span>
                                            </div>
                                        )}
                                        {it.claim}
                                        {it.citations.length > 0 && (
                                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                                {it.citations.map((c, i) => (
                                                    <CitationChip key={`${c.camId}-${c.t}-${i}`} c={c} />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                    </div>
                )}

                {open.map(c => (
                    <Panel key={c.id}>
                        <Label className="mb-1">Contradiction</Label>
                        <div className="text-muted-fg">
                            {c.cams[0]} “{c.a}” vs {c.cams[1]} “{c.b}”. Asking both cameras to look again.
                        </div>
                    </Panel>
                ))}
                {resolved.map(c => (
                    <Panel key={c.id}>
                        <Label className="mb-1">Contradiction resolved</Label>
                        <div className="text-muted-fg">
                            {c.cams[0]} “{c.a}” vs {c.cams[1]} “{c.b}”. {c.resolution}
                        </div>
                    </Panel>
                ))}

                {inc.summary && (
                    <div className="rounded-lg bg-muted px-3.5 py-3">
                        <div className="mb-1 flex items-center justify-between">
                            <Label>Verdict</Label>
                            <span className="text-[13px] text-muted-fg">Revision {inc.revision}</span>
                        </div>
                        {inc.summary}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

// The server marks a sighting `inferred` when nobody saw the way there (blind spot or long gap): it's still a real
// sighting with a frame, drawn normally behind a dashed "unseen Ns" connector. An inferred point WITHOUT a frame
// is a placeholder. When the person's last sighting is well before the window ends, they're "not seen again".
const NOT_SEEN_AFTER_MS = 5000

function Storyboard({ points, windowEnd }: { points: PathPoint[]; windowEnd: number }) {
    const { openCamera } = useDash()
    const pts = [...points].sort((a, b) => a.t - b.t)
    const tail = pts[pts.length - 1]
    if (tail && !(tail.inferred && !tail.frameRef) && windowEnd - tail.t > NOT_SEEN_AFTER_MS)
        pts.push({ t: windowEnd, camId: tail.camId, inferred: true })
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {pts.map((pt, i) => {
                const prev = pts[i - 1]
                const placeholder = pt.inferred && !pt.frameRef
                const unseen = !!prev && pt.inferred
                const last = i === pts.length - 1
                return (
                    <Fragment key={`${i}-${pt.camId}-${pt.inferred}`}>
                        {prev && (
                            <div className="flex flex-col items-center gap-[3px] pb-[30px]">
                                <i className={cn("block w-10 border-t", unseen ? "border-dashed border-subtle" : "border-muted-fg")} />
                                <small className="font-mono text-[11px] text-muted-fg">
                                    {placeholder ? "unseen" : `${unseen ? "unseen " : ""}${seconds(Math.max(0, pt.t - prev.t))}`}
                                </small>
                            </div>
                        )}
                        <div className="flex flex-col items-center gap-[3px]">
                            {placeholder ? (
                                <Thumb dashed className="h-[46px] w-20 rounded-md" />
                            ) : (
                                <button
                                    type="button"
                                    className="cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                    onClick={() => openCamera(pt.camId, pt.frameRef ? { t: pt.t, frameRef: pt.frameRef } : undefined)}
                                >
                                    <Thumb frameRef={pt.frameRef} className="h-[46px] w-20 rounded-md" />
                                </button>
                            )}
                            <span className="text-xs font-medium">{placeholder ? "—" : pt.camId}</span>
                            <span className="font-mono text-[11px] text-subtle">{placeholder && last ? "not seen again" : clock(pt.t)}</span>
                        </div>
                    </Fragment>
                )
            })}
        </div>
    )
}

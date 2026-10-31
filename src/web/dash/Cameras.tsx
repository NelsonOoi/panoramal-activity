import { useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import type { CameraMeta } from "../../shared/types"
import { clock, seconds } from "../lib/format"
import type { DashState } from "../lib/store"
import { Badge, Button, Card, CardContent, CardHeader, Label, Panel, cn } from "../ui"
import { statusOf, useDash } from "./ctx"
import { Scene, Thumb, useSidecar } from "./frame"

const PAGE = 4

function score(c: CameraMeta, s: DashState, alerted: Set<string>) {
    const guest = c.kind === "upload"
    const live = c.online || guest
    const people = live && (s.lastObs[c.id]?.people ?? 0) > 0
    return (alerted.has(c.id) ? 8 : 0) + (people ? 4 : 0) + (live ? 2 : 0) + (guest ? 1 : 0)
}

// Most active first. The order only changes when a score input changes (alert, people in view,
// online, joining), never on every frame: observation counts break ties at that moment only.
function useOrder(s: DashState, alerted: Set<string>) {
    const cams = Object.values(s.cameras)
    const sig = cams
        .map(c => `${c.id}:${score(c, s, alerted)}`)
        .sort()
        .join("|")
    const ref = useRef({ s, alerted })
    ref.current = { s, alerted }
    return useMemo(() => {
        const { s, alerted } = ref.current
        const list = Object.values(s.cameras)
        const sc = new Map(list.map(c => [c.id, score(c, s, alerted)]))
        return list
            .sort((a, b) => sc.get(b.id)! - sc.get(a.id)! || b.observations - a.observations || a.id.localeCompare(b.id))
            .map(c => c.id)
    }, [sig])
}

export function CamerasCard({ state, publicUrl, className }: { state: DashState; publicUrl: string; className?: string }) {
    const alerted = useMemo(() => new Set(state.alerts.filter(a => a.status === "raised").map(a => a.camId)), [state.alerts])
    const order = useOrder(state, alerted)
    const [page, setPage] = useState(0)
    const pages = Math.max(1, Math.ceil(order.length / PAGE))
    const p = Math.min(page, pages - 1)
    const visible = order.slice(p * PAGE, p * PAGE + PAGE)
    const empty = order.length === 0

    return (
        <Card className={className}>
            <CardHeader
                title="Cameras"
                description="Most active first. Select a camera to see its latest analysis."
                right={
                    !empty && (
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-[13px] text-muted-fg">
                                {p * PAGE + 1}–{Math.min(order.length, p * PAGE + PAGE)} of {order.length}
                            </span>
                            <Button size="icon" aria-label="Previous cameras" disabled={p === 0} onClick={() => setPage(p - 1)}>
                                <ChevronLeft size={16} />
                            </Button>
                            <Button size="icon" aria-label="Next cameras" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
                                <ChevronRight size={16} />
                            </Button>
                        </div>
                    )
                }
            />
            <CardContent className="scroll-thin min-h-0 flex-1 overflow-auto">
                {empty ? (
                    <EmptyWall url={`${publicUrl}/capture`} />
                ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {visible.map(id => (
                            <Tile key={id} cam={state.cameras[id]} state={state} alert={alerted.has(id)} />
                        ))}
                    </div>
                )}
                <div className="flex flex-wrap gap-3">
                    <Handoffs state={state} />
                    <div className="flex flex-[1_1_220px] flex-col gap-3">
                        {!empty && <QrCard url={`${publicUrl}/capture`} title="Add camera" sub="Scan with a phone" />}
                        <QrCard url={`${publicUrl}/witness`} title="Saw something?" sub="Add your footage" />
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}

function Tile({ cam, state, alert }: { cam: CameraMeta; state: DashState; alert: boolean }) {
    const { openCamera } = useDash()
    const last = state.lastObs[cam.id]
    const people = useSidecar(last?.frameRef)
    const st = statusOf(cam)
    const off = !cam.online && cam.kind !== "upload"
    const frames = (state.frames[cam.id] ?? []).slice(-6)
    const spots = state.blindSpots.filter(b => b.camId === cam.id && b.count >= 3)
    const inView = !last
        ? "Waiting for the first frame"
        : off
          ? `Last frame ${clock(last.t)}`
          : people && people.length
            ? people.map(p => `${p.id} · ${p.desc}${p.action ? `, ${p.action}` : ""}`).join("; ")
            : last.people > 0
              ? `${last.people} in view`
              : "Nobody in view"
    return (
        <button
            type="button"
            onClick={() => openCamera(cam.id)}
            data-cam={cam.id}
            className="flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-[10px] border border-border p-2.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
            <Scene frameRef={last?.frameRef} people={off ? [] : people} dim={off} className="max-h-[max(120px,calc((100dvh-600px)/2))] w-full" empty="No frame yet" />
            <div className="flex items-center gap-2">
                <span className="font-medium">{cam.id}</span>
                <Badge variant={st.variant}>{st.label}</Badge>
                {alert && (
                    <Badge variant="destructive" className="h-[18px] px-1.5 text-[11px]">
                        Alert
                    </Badge>
                )}
                <span className="ml-auto font-mono text-xs text-subtle">{cam.observations} obs</span>
            </div>
            <div className="min-h-5 truncate text-[13px] text-muted-fg" title={inView}>
                {inView}
            </div>
            {spots.length > 0 && (
                <div className="-mt-1.5 truncate text-xs text-subtle">
                    {spots.map(b => `Blind spot at the ${b.edge} edge · ${b.count} unmatched exits`).join("; ")}
                </div>
            )}
            <div className="flex gap-1">
                {Array.from({ length: 6 }, (_, k) => {
                    const f = frames[k]
                    return <Thumb key={f?.frameRef ?? `e${k}`} frameRef={f?.frameRef} dashed={!f} className={cn("h-5 flex-1", off && "opacity-40")} />
                })}
            </div>
        </button>
    )
}

function Handoffs({ state }: { state: DashState }) {
    // One row per camera pair, transits pooled across edge sides.
    const rows = useMemo(() => {
        const m = new Map<string, { a: string; b: string; transits: number[] }>()
        for (const e of Object.values(state.edges)) {
            const k = `${e.from.camId}->${e.to.camId}`
            const r = m.get(k) ?? { a: e.from.camId, b: e.to.camId, transits: [] }
            r.transits.push(...e.transits)
            m.set(k, r)
        }
        return [...m.values()].filter(r => r.transits.length > 0).sort((x, y) => y.transits.length - x.transits.length)
    }, [state.edges])
    return (
        <Panel className="flex-[2_1_280px]">
            <Label className="mb-2">Learned handoffs</Label>
            {rows.length === 0 ? (
                <div className="text-[13px] text-muted-fg">None yet. They appear as people walk from one camera to another.</div>
            ) : (
                <div className="scroll-thin max-h-36 overflow-auto">
                    {rows.map(r => {
                        const avg = r.transits.reduce((x, y) => x + y, 0) / r.transits.length
                        return (
                            <div key={`${r.a}-${r.b}`} className="flex items-center gap-2 border-t border-border py-2 first:border-t-0 first:pt-0">
                                <span>{r.a}</span>
                                <span className="text-subtle">→</span>
                                <span>{r.b}</span>
                                <span className="ml-auto font-mono text-xs text-muted-fg">
                                    {seconds(avg)} avg · {r.transits.length} seen
                                </span>
                            </div>
                        )
                    })}
                </div>
            )}
        </Panel>
    )
}

function QrCard({ url, title, sub }: { url: string; title: string; sub: string }) {
    return (
        <Panel className="flex items-center gap-3">
            <div className="shrink-0 rounded-md bg-[#fafafa] p-1">
                <QRCodeSVG value={url} size={48} level="M" marginSize={0} bgColor="#fafafa" fgColor="#09090b" />
            </div>
            <div className="min-w-0">
                <Label>{title}</Label>
                <div className="truncate text-[13px] text-muted-fg">{sub}</div>
            </div>
        </Panel>
    )
}

function EmptyWall({ url }: { url: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-5 rounded-[10px] border border-dashed border-border px-6 py-10 text-center">
            <div className="rounded-lg bg-[#fafafa] p-3">
                <QRCodeSVG value={url} size={220} level="M" marginSize={0} bgColor="#fafafa" fgColor="#09090b" />
            </div>
            <div>
                <div className="text-[17px] font-semibold">Add camera</div>
                <div className="text-[13px] text-muted-fg">Scan with a phone. It joins the site as a camera and starts remembering what it sees.</div>
                <div className="mt-1 font-mono text-xs text-subtle">{url.replace(/^https?:\/\//, "")}</div>
            </div>
        </div>
    )
}

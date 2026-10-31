import { useEffect, useState } from "react"
import { Button, Checkbox, Dialog, DialogHeader, Segmented, Textarea } from "../ui"

export interface NewIncidentReq {
    question: string
    t0: number
    t1: number
    camIds: string[]
}

type Win = "1" | "5" | "15" | "custom"
const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
function todayAt(v: string) {
    const [h, m] = v.split(":").map(Number)
    const d = new Date()
    d.setHours(h || 0, m || 0, 0, 0)
    return d.getTime()
}

export function NewIncident({ open, camIds, onClose, onStart }: { open: boolean; camIds: string[]; onClose: () => void; onStart: (r: NewIncidentReq) => void }) {
    const [q, setQ] = useState("")
    const [win, setWin] = useState<Win>("5")
    const [from, setFrom] = useState("")
    const [to, setTo] = useState("")
    const [sel, setSel] = useState<Set<string>>(new Set(camIds))
    useEffect(() => {
        if (!open) return
        const now = Date.now()
        setQ("")
        setWin("5")
        setFrom(hhmm(now - 5 * 60_000))
        setTo(hhmm(now))
        setSel(new Set(camIds))
        // camIds read on open only
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])
    const submit = () => {
        const now = Date.now()
        let t0 = now - Number(win) * 60_000
        let t1 = now
        if (win === "custom") {
            t0 = todayAt(from)
            t1 = todayAt(to) + 59_999
            if (t1 < t0) [t0, t1] = [t1, t0]
        }
        onStart({ question: q.trim() || "What happened?", t0, t1, camIds: camIds.filter(id => sel.has(id)) })
    }
    return (
        <Dialog open={open} onClose={onClose} size="sm" labelledBy="inc-title">
            <DialogHeader id="inc-title" title="New incident" description="Starts a fresh investigation. Each selected camera is questioned over Relay." onClose={onClose} />
            <form
                className="flex flex-col gap-[18px] px-[22px] pt-5 pb-[22px]"
                onSubmit={e => {
                    e.preventDefault()
                    submit()
                }}
            >
                <div className="flex flex-col gap-2">
                    <label className="text-[13px] font-medium" htmlFor="inc-q">
                        Question
                    </label>
                    <Textarea id="inc-q" value={q} onChange={e => setQ(e.target.value)} placeholder="What happened at the table?" autoFocus />
                </div>
                <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-medium" id="win-lbl">
                        Time window
                    </span>
                    <Segmented<Win>
                        labelledBy="win-lbl"
                        value={win}
                        onChange={setWin}
                        options={[
                            { value: "1", label: "Last 1 min" },
                            { value: "5", label: "Last 5 min" },
                            { value: "15", label: "Last 15 min" },
                            { value: "custom", label: "Custom" }
                        ]}
                    />
                    {win === "custom" && (
                        <div className="flex items-center gap-2.5">
                            <label htmlFor="inc-from" className="text-[13px] text-muted-fg">
                                From
                            </label>
                            <input id="inc-from" type="time" value={from} onChange={e => setFrom(e.target.value)} className="h-9 w-[130px] rounded-lg border border-input bg-transparent px-3 outline-none focus:border-ring [color-scheme:dark]" />
                            <label htmlFor="inc-to" className="text-[13px] text-muted-fg">
                                to
                            </label>
                            <input id="inc-to" type="time" value={to} onChange={e => setTo(e.target.value)} className="h-9 w-[130px] rounded-lg border border-input bg-transparent px-3 outline-none focus:border-ring [color-scheme:dark]" />
                        </div>
                    )}
                </div>
                <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-medium" id="cams-lbl">
                        Cameras
                    </span>
                    {camIds.length === 0 ? (
                        <div className="text-[13px] text-muted-fg">No cameras yet.</div>
                    ) : (
                        <div role="group" aria-labelledby="cams-lbl" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {camIds.map(id => (
                                <Checkbox
                                    key={id}
                                    label={id}
                                    checked={sel.has(id)}
                                    onChange={v =>
                                        setSel(s => {
                                            const n = new Set(s)
                                            if (v) n.add(id)
                                            else n.delete(id)
                                            return n
                                        })
                                    }
                                />
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button type="submit" variant="primary" disabled={camIds.length > 0 && sel.size === 0}>
                        Start investigation
                    </Button>
                </div>
            </form>
        </Dialog>
    )
}

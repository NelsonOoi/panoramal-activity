import { useEffect, useMemo, useRef } from "react"
import type { IncidentState, RelayCard, RelayKind } from "../../shared/types"
import { Badge, Card, CardContent, CardHeader, cn } from "../ui"

const KIND: Record<RelayKind, string> = {
    question: "Question",
    testimony: "Testimony",
    reexamine: "Re-examine",
    answer: "Answer",
    alert: "Alert",
    knock: "Knock",
    admit: "Admit",
    verdict: "Verdict"
}

export function RelayCardView({ cards, incident, className }: { cards: RelayCard[]; incident: IncidentState | null; className?: string }) {
    // Replies nest under the card they answer (one level: replies of replies join the root).
    const rows = useMemo(() => {
        const recent = cards.slice(-80)
        const byId = new Map(recent.map(c => [c.id, c]))
        const root = (c: RelayCard): string => {
            let cur = c
            for (let i = 0; i < 5 && cur.threadOf && byId.has(cur.threadOf); i++) cur = byId.get(cur.threadOf)!
            return cur.id
        }
        const kids = new Map<string, RelayCard[]>()
        const tops: RelayCard[] = []
        for (const c of recent) {
            const r = root(c)
            if (r === c.id) tops.push(c)
            else kids.set(r, [...(kids.get(r) ?? []), c])
        }
        return tops.flatMap(t => [{ c: t, nest: false }, ...(kids.get(t.id) ?? []).map(c => ({ c, nest: true }))])
    }, [cards])
    const scroller = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const el = scroller.current
        if (el) el.scrollTop = el.scrollHeight
    }, [rows.length])
    const chan = incident ? `#incident-${incident.id.replace(/^inc-/, "")}` : "#site"
    return (
        <Card className={className}>
            <CardHeader title="Relay" description="Messages between agents" right={<Badge className="font-mono">{chan}</Badge>} />
            <CardContent className="min-h-0 flex-1">
                <div ref={scroller} className="scroll-thin -mr-2 flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-2">
                    {rows.length === 0 && <div className="text-[13px] text-muted-fg">Quiet. Questions, testimony and verdicts appear here as the agents talk.</div>}
                    {rows.map(({ c, nest }) => (
                        <div key={c.id} className={cn("rounded-lg border border-border px-3 py-2.5", nest && "ml-[18px] bg-hover")}>
                            <div className="flex items-center gap-2 text-[13px]">
                                <span className="font-medium">{c.from}</span>
                                <span className="min-w-0 truncate text-subtle">→ {c.to}</span>
                                <Badge className="ml-auto">{KIND[c.kind] ?? c.kind}</Badge>
                            </div>
                            <div className="mt-1 break-words">{c.text}</div>
                        </div>
                    ))}
                </div>
                <div className="text-[13px] text-muted-fg">via Agent Relay</div>
            </CardContent>
        </Card>
    )
}

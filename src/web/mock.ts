// A hand-written DashEvent script covering the whole DEMO.md story. `/dash?mock=1` plays it.
import type { Alert, CameraMeta, DashEvent, IncidentState, RelayCard, SiteEdge, TimelineItem } from "../shared/types"
import { CAMERA_COLORS } from "../shared/types"
import type { Recorded } from "./lib/source"

export function buildMock(t0 = Date.now()): Recorded[] {
    const out: Recorded[] = []
    const at = (ms: number, event: DashEvent) => out.push({ at: ms, event })
    const T = (ms: number) => t0 + ms
    const frame = (cam: string) => `/mock-frames/${cam}.svg`

    const cam = (n: number, extra: Partial<CameraMeta> = {}): CameraMeta => ({
        id: `cam-${n}`,
        kind: "fixed",
        color: CAMERA_COLORS[n - 1],
        pos: null,
        facing: 180,
        online: true,
        observations: 0,
        offsetMs: 0,
        offsetErrMs: 8 + n * 3,
        admitted: true,
        ...extra
    })
    const placed: Record<string, Pick<CameraMeta, "pos" | "facing">> = {
        "cam-1": { pos: { x: 0.42, y: 0.7 }, facing: 180 },
        "cam-2": { pos: { x: 0.8, y: 0.24 }, facing: 225 },
        "cam-3": { pos: { x: 0.2, y: 0.26 }, facing: 135 }
    }

    at(0, {
        type: "snapshot",
        site: { cameras: [], edges: [], blindSpots: [], entities: [], currentIncidentId: null, knocks: [], alerts: [] }
    })

    // Cameras join, then get dragged into place.
    const obsCount: Record<string, number> = { "cam-1": 0, "cam-2": 0, "cam-3": 0 }
    ;[1, 2, 3].forEach((n, i) => {
        const id = `cam-${n}`
        at(2500 + i * 1800, { type: "camera", camera: cam(n) })
        at(3600 + i * 1800, { type: "camera", camera: cam(n, placed[id]) })
    })

    // Observation heartbeat for each camera through the whole run.
    for (let ms = 3000; ms < 96000; ms += 1100) {
        for (const [i, id] of ["cam-1", "cam-2", "cam-3"].entries()) {
            const joinedAt = 2500 + i * 1800
            if (ms < joinedAt + 300) continue
            if ((ms / 1100 + i) % 3 > 1.2) continue
            obsCount[id]++
            const people = ms > 9000 && ms < 72000 && (ms / 1100 + i) % 2 < 1 ? 1 : 0
            at(ms + i * 230, { type: "observation", camId: id, t: T(ms + i * 230), people, frameRef: frame(id) })
        }
    }

    // Calibration walk: links draw in, the blind exit goes red.
    const edge = (from: string, fe: SiteEdge["from"]["edge"], to: string, te: SiteEdge["to"]["edge"], transits: number[]): SiteEdge => ({
        id: `${from}:${fe}->${to}:${te}`,
        from: { camId: from, edge: fe },
        to: { camId: to, edge: te },
        transits
    })
    at(12500, { type: "edge", edge: edge("cam-1", "top", "cam-3", "bottom", [3400]), isNew: true })
    at(16000, { type: "blind-spot", spot: { camId: "cam-1", edge: "left", count: 1 } })
    at(19500, { type: "edge", edge: edge("cam-3", "right", "cam-2", "left", [2100]), isNew: true })
    at(23000, { type: "edge", edge: edge("cam-2", "bottom", "cam-1", "right", [4200]), isNew: true })
    at(25500, { type: "edge", edge: edge("cam-1", "top", "cam-3", "bottom", [3400, 3000]), isNew: false })

    // The theft triggers an alert.
    const alertId = "al-1"
    const alert: Alert = {
        id: alertId,
        camId: "cam-2",
        t: T(31800),
        text: "Yellow tote is gone from the table",
        frameRef: frame("cam-2"),
        kind: "object-gone",
        status: "raised",
        escalateAt: T(31800 + 30000),
        history: [{ status: "raised", at: T(31800) }]
    }
    at(32000, { type: "alert", alert })
    let cid = 0
    const card = (ms: number, c: Omit<RelayCard, "id" | "t">): RelayCard => {
        const full: RelayCard = { id: `rc-${++cid}`, t: T(ms), ...c }
        at(ms, { type: "relay", card: full })
        return full
    }
    card(32400, { kind: "alert", from: "cam-2", to: "#site", text: "Yellow tote is gone from the table." })

    // Incident opens.
    const window: [number, number] = [T(31800 - 30000), T(31800 + 15000)]
    const q = "Who took the yellow tote?"
    const transcript: RelayCard[] = []
    const base: IncidentState = {
        id: "inc-1",
        question: q,
        window,
        status: "gathering",
        witnesses: [
            { camId: "cam-1", status: "asked" },
            { camId: "cam-2", status: "asked" },
            { camId: "cam-3", status: "asked" }
        ],
        timeline: [],
        contradictions: [],
        paths: [],
        summary: null,
        revision: 0,
        transcript
    }
    let inc = base
    const push = (ms: number, patch: Partial<IncidentState>, changed: string[] = []) => {
        inc = { ...inc, ...patch, revision: patch.revision ?? inc.revision, transcript: [...transcript] }
        at(ms, { type: "incident", incident: inc, changed })
    }
    push(34000, {})
    at(34100, {
        type: "alert",
        alert: { ...alert, status: "investigating", incId: "inc-1", history: [...alert.history, { status: "investigating", at: T(34000) }] }
    })
    const question = card(35500, {
        kind: "question",
        from: "investigator",
        to: "#incident-1",
        incId: "inc-1",
        text: `${q} Tell me what you saw between ${hm(window[0])} and ${hm(window[1])}: who came near the table, and where did they go?`
    })
    transcript.push(question)

    const cite = (camId: string, ms: number) => ({ camId, t: T(ms), frameRef: frame(camId) })
    const items: Record<string, TimelineItem> = {
        enter: {
            id: "ti-enter",
            t: T(24800),
            claim: "Person A (navy jacket, red beanie) comes in through the entrance.",
            entityIds: ["A"],
            citations: [cite("cam-1", 24800)],
            confidence: 0.93,
            inferred: false
        },
        approach: {
            id: "ti-approach",
            t: T(28400),
            claim: "Person A walks to the table and stops beside the yellow tote.",
            entityIds: ["A"],
            citations: [cite("cam-3", 28400), cite("cam-2", 28900)],
            confidence: 0.88,
            inferred: false
        },
        grab: {
            id: "ti-grab",
            t: T(31800),
            claim: "Person A picks up the yellow tote in one motion.",
            entityIds: ["A"],
            citations: [cite("cam-2", 31800), cite("cam-3", 31900)],
            confidence: 0.95,
            inferred: false
        },
        leave: {
            id: "ti-leave",
            t: T(37000),
            claim: "Person A probably leaves through the unwatched exit on the right. No camera saw it.",
            entityIds: ["A"],
            citations: [cite("cam-2", 34100)],
            confidence: 0.55,
            inferred: true
        }
    }

    const t1 = card(38500, {
        kind: "testimony",
        from: "cam-1",
        to: "#incident-1",
        incId: "inc-1",
        threadOf: question.id,
        text: `${hm(T(24800))} One person came in through the entrance: navy jacket, red beanie. Heading toward the table.`
    })
    transcript.push(t1)
    push(39000, {
        witnesses: [
            { camId: "cam-1", status: "answered" },
            { camId: "cam-2", status: "asked" },
            { camId: "cam-3", status: "asked" }
        ],
        timeline: [items.enter]
    })

    const t3 = card(42000, {
        kind: "testimony",
        from: "cam-3",
        to: "#incident-1",
        incId: "inc-1",
        threadOf: question.id,
        text: `${hm(T(28400))} Person in a black jacket stopped at the table. ${hm(T(31900))} They lifted the yellow tote.`
    })
    transcript.push(t3)
    push(42500, {
        witnesses: [
            { camId: "cam-1", status: "answered" },
            { camId: "cam-2", status: "asked" },
            { camId: "cam-3", status: "answered" }
        ],
        timeline: [items.enter, items.approach]
    })

    const t2 = card(45000, {
        kind: "testimony",
        from: "cam-2",
        to: "#incident-1",
        incId: "inc-1",
        threadOf: question.id,
        text: `${hm(T(31800))} Person A, navy jacket, red beanie, picked up the yellow tote and walked off toward the bottom right of my view.`
    })
    transcript.push(t2)
    const contradiction = {
        id: "co-1",
        a: "navy jacket",
        b: "black jacket",
        cams: ["cam-2", "cam-3"] as [string, string],
        resolution: null as string | null
    }
    const pathA = (inferredEnd: boolean) => ({
        entityId: "A",
        desc: "navy jacket, red beanie",
        points: [
            { t: T(24800), camId: "cam-1", inferred: false, frameRef: frame("cam-1") },
            { t: T(28400), camId: "cam-3", inferred: false, frameRef: frame("cam-3") },
            { t: T(31800), camId: "cam-2", inferred: false, frameRef: frame("cam-2") },
            inferredEnd
                ? { t: T(37000), camId: "cam-2", inferred: true }
                : { t: T(36200), camId: "guest-7f3a", inferred: false, frameRef: frame("guest") }
        ]
    })
    push(45600, {
        status: "analysing",
        witnesses: [
            { camId: "cam-1", status: "answered" },
            { camId: "cam-2", status: "answered" },
            { camId: "cam-3", status: "answered" }
        ],
        timeline: [items.enter, items.approach, items.grab, items.leave],
        contradictions: [contradiction],
        paths: [pathA(true)]
    })

    const re3 = card(48000, {
        kind: "reexamine",
        from: "investigator",
        to: "@cam-3",
        incId: "inc-1",
        text: `Look again at your frame from ${hm(T(31900))}. Jacket colour: black or navy?`
    })
    const re2 = card(49200, {
        kind: "reexamine",
        from: "investigator",
        to: "@cam-2",
        incId: "inc-1",
        text: `Confirm the jacket colour in your frame from ${hm(T(31800))}.`
    })
    transcript.push(re3, re2)
    push(49400, {})
    const a2 = card(52500, {
        kind: "answer",
        from: "cam-2",
        to: "@investigator",
        incId: "inc-1",
        threadOf: re2.id,
        text: "Navy. The jacket is lit from the front and the blue is clear against the wall."
    })
    const a3 = card(54500, {
        kind: "answer",
        from: "cam-3",
        to: "@investigator",
        incId: "inc-1",
        threadOf: re3.id,
        text: "I'm looking into the window light; the jacket is in shadow. Navy is consistent with what I see."
    })
    transcript.push(a2, a3)
    const summary1 =
        "Person A, in a navy jacket and red beanie, came in through the entrance, picked up the yellow tote at the table and most likely left through the unwatched exit on the right. cam-3 read the jacket as black because it was backlit."
    push(55500, {
        status: "done",
        contradictions: [{ ...contradiction, resolution: "Navy. cam-3 was backlit by the window; cam-2 had a clear, front-lit view." }],
        timeline: [items.enter, items.approach, { ...items.grab, confidence: 0.97 }, items.leave],
        summary: summary1,
        revision: 1
    }, ["ti-grab"])
    const v1 = card(56200, { kind: "verdict", from: "investigator", to: "#incident-1", incId: "inc-1", text: summary1 })
    transcript.push(v1)

    // Late witness knocks.
    const offer = `clip ${hm(T(30000))}–${hm(T(40000))}`
    at(61000, { type: "knock", knock: { guestId: "guest-7f3a", offer, status: "uploading", message: null } })
    at(64000, { type: "knock", knock: { guestId: "guest-7f3a", offer, status: "waiting", message: null } })
    const kn = card(64300, { kind: "knock", from: "guest-7f3a", to: "@site", text: `Wants to add footage: ${offer}.` })
    transcript.push(kn)
    at(70000, { type: "knock", knock: { guestId: "guest-7f3a", offer, status: "approved", message: null } })
    const ad = card(70300, { kind: "admit", from: "site", to: "@guest-7f3a", incId: "inc-1", text: "Admitted to #incident-1. Clip aligned to site time by matching the bag pickup (±40 ms)." })
    transcript.push(ad)
    at(70600, {
        type: "camera",
        camera: {
            id: "guest-7f3a",
            kind: "upload",
            color: CAMERA_COLORS[3],
            pos: null,
            facing: 90,
            online: true,
            observations: 10,
            offsetMs: -2380,
            offsetErrMs: 40,
            admitted: true
        }
    })
    push(71000, {
        status: "gathering",
        witnesses: [
            { camId: "cam-1", status: "answered" },
            { camId: "cam-2", status: "answered" },
            { camId: "cam-3", status: "answered" },
            { camId: "guest-7f3a", status: "asked" }
        ]
    })
    const tg = card(75500, {
        kind: "testimony",
        from: "guest-7f3a",
        to: "#incident-1",
        incId: "inc-1",
        threadOf: question.id,
        text: `${hm(T(36200))} Someone in a navy jacket with a yellow tote went out the side door by the stage.`
    })
    transcript.push(tg)
    const leave2: TimelineItem = {
        ...items.leave,
        t: T(36200),
        claim: "Person A leaves through the side door by the stage, carrying the yellow tote.",
        citations: [cite("guest-7f3a", 36200)],
        confidence: 0.91,
        inferred: false,
        revisedFrom: items.leave.claim
    }
    const summary2 =
        "Person A, in a navy jacket and red beanie, came in through the entrance, picked up the yellow tote at the table and left through the side door by the stage, which no site camera covers. A guest's clip confirmed the exit."
    push(77000, {
        status: "done",
        witnesses: [
            { camId: "cam-1", status: "answered" },
            { camId: "cam-2", status: "answered" },
            { camId: "cam-3", status: "answered" },
            { camId: "guest-7f3a", status: "answered" }
        ],
        timeline: [items.enter, items.approach, { ...items.grab, confidence: 0.97 }, leave2],
        paths: [pathA(false)],
        summary: summary2,
        revision: 2
    }, ["ti-leave"])
    at(77400, {
        type: "knock",
        knock: {
            guestId: "guest-7f3a",
            offer,
            status: "done",
            message: "Thanks. Your clip covered a 6-second gap at the side door and confirmed where the person went."
        }
    })
    const v2 = card(78500, { kind: "verdict", from: "investigator", to: "#incident-1", incId: "inc-1", text: `Revised: ${summary2}` })
    transcript.push(v2)
    push(78700, {})

    return out.sort((a, b) => a.at - b.at)
}

function hm(t: number) {
    return new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

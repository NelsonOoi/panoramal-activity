// Relay bridge: one Relay agent per camera, plus "investigator" and "site". Owner: track C.
// Keep this file importable at all times: src/server.ts imports it. Every export catches its own errors.
//
// Message bus: send() publishes the dashboard card and dispatches to the in-process recipient at once
// (RELAY_LOCAL_DELIVERY, default on), and fires the real Relay send in the background. The Relay listener
// dispatches too, deduped by body.id, so with RELAY_LOCAL_DELIVERY=0 everything genuinely runs over Relay.
import { AgentRelay } from "@agent-relay/sdk"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

import { actors } from "../generated/index.js"
import { analyse, hasLLM, NoLLMError, resolveContradictions, witnessAsk, witnessReexamine, witnessTestimony, type AnalysisOutput, type ReexamineAnswer } from "./investigator.js"
import { publish } from "./publish.js"
import type { Alert, AskResult, Claim, Contradiction, DashEvent, IncidentState, Observation, RelayCard, RelayKind, SiteEdge, BlindSpot, Testimony } from "./shared/types.js"

const TOKENS_FILE = process.env.RELAY_TOKENS_FILE ?? ".relay-tokens.json"
const AGENT_PREFIX = process.env.RELAY_AGENT_PREFIX ?? "" // test harnesses namespace their Relay agents
const RELAY_LOG = ".logs/relay.log"
const TESTIMONY_DEADLINE_MS = 10_000
const ANSWER_DEADLINE_MS = 6_000
const localDelivery = () => process.env.RELAY_LOCAL_DELIVERY !== "0"
const PROCESS_START = Date.now()

type Body = {
    id: string
    kind: RelayKind
    from: string // logical agent id
    to: string // logical target: "#incident-1", "@cam-2", "#site"
    sentAt: number
    incId?: string
    threadOf?: string
    [k: string]: any
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const clock = (t: number) => new Date(t).toISOString().slice(11, 19)
const log = (...a: any[]) => console.log("[relay]", ...a)
const warn = (...a: any[]) => console.warn("[relay]", ...a)
const errMsg = (e: any) => `${e?.code ?? e?.status ?? ""} ${e?.message ?? e}`.trim()

function relayLog(entry: Record<string, unknown>) {
    try {
        mkdirSync(".logs", { recursive: true })
        appendFileSync(RELAY_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n")
    } catch {}
}

let idSeq = 0
const newId = (kind: string) => `${kind.slice(0, 3)}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`

// ---------------------------------------------------------------- test hooks

type RecallFn = (camId: string, t0: number, t1: number) => Promise<Observation[]>
const hooks: {
    recall: RecallFn | null
    paths: ((t0: number, t1: number) => Promise<IncidentState["paths"]>) | null
    layout: (() => Promise<{ edges: SiteEdge[]; blindSpots: BlindSpot[] }>) | null
} = { recall: null, paths: null, layout: null }
// For scripts/c-*.ts harnesses only: replace actor reads with synthetic data.
export function __setTestHooks(h: Partial<typeof hooks>) {
    Object.assign(hooks, h)
}

async function recall(camId: string, t0: number, t1: number): Promise<Observation[]> {
    try {
        return hooks.recall ? await hooks.recall(camId, t0, t1) : await actors.CameraActor.get(camId).recall(t0, t1)
    } catch (e) {
        warn(`recall ${camId} failed:`, errMsg(e))
        return []
    }
}

async function sitePaths(t0: number, t1: number): Promise<IncidentState["paths"]> {
    try {
        return hooks.paths ? await hooks.paths(t0, t1) : await actors.SiteActor.get("site").paths(t0, t1)
    } catch (e) {
        warn("SiteActor.paths failed:", errMsg(e))
        return []
    }
}

async function siteLayout(): Promise<{ edges: SiteEdge[]; blindSpots: BlindSpot[] }> {
    try {
        return hooks.layout ? await hooks.layout() : await actors.SiteActor.get("site").layout()
    } catch (e) {
        warn("SiteActor.layout failed:", errMsg(e))
        return { edges: [], blindSpots: [] }
    }
}

const incident = (incId: string) => actors.IncidentActor.get(incId)

async function safePublish(ev: DashEvent) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await publish(ev)
        } catch (e) {
            if (attempt === 2) warn(`publish ${ev.type} failed:`, errMsg(e))
            else await sleep(1000) // the actor host is briefly unavailable while it hot-reloads
        }
    }
}

async function publishIncident(incId: string, inc: IncidentState | null, changed: string[] = []) {
    if (inc) await safePublish({ type: "incident", incident: inc, changed })
}

// ---------------------------------------------------------------- Relay plumbing

type Client = Awaited<ReturnType<AgentRelay["workspace"]["reconnect"]>>
type Store = { agents: Record<string, { name: string; token: string }> }

let relay: AgentRelay | null = null
const clients = new Map<string, Promise<Client | null>>() // logical agent id -> client
const channelReady = new Map<string, Promise<void>>() // `${agentId}:${channel}`
const relayIds = new Map<string, string>() // body.id -> Relay messageId
const sendPromises = new Map<string, Promise<string | null>>()
const dispatched = new Set<string>()
const delivered = new Set<string>() // Relay deliveries already logged
const active = new Set<string>() // incidents this process is investigating

function loadStore(): Store {
    try {
        if (existsSync(TOKENS_FILE)) return JSON.parse(readFileSync(TOKENS_FILE, "utf8"))
    } catch (e) {
        warn("bad .relay-tokens.json, starting fresh:", errMsg(e))
    }
    return { agents: {} }
}

function saveAgent(agentId: string, name: string, token: string) {
    try {
        const s = loadStore()
        s.agents[agentId] = { name, token }
        writeFileSync(TOKENS_FILE, JSON.stringify(s, null, 2))
    } catch (e) {
        warn("could not save .relay-tokens.json:", errMsg(e))
    }
}

const relayNameOf = (agentId: string) => loadStore().agents[agentId]?.name ?? agentId

function isRetryable(e: any) {
    return e?.retryable === true || e?.status === 503 || e?.statusCode === 503 || e?.status === 429 || /database_overloaded|overloaded|ECONNRESET|fetch failed/i.test(String(e?.code ?? "") + String(e?.message ?? ""))
}

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 2): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn()
        } catch (e: any) {
            if (attempt >= tries || !isRetryable(e)) throw e
            const wait = Math.min(Number(e?.retryAfterMs) || 1500, 8000)
            warn(`${label}: ${errMsg(e)}; retry ${attempt + 1}/${tries} in ${wait}ms`)
            relayLog({ op: "retry", label, err: errMsg(e), wait })
            await sleep(wait)
        }
    }
}

function getRelay(): AgentRelay | null {
    if (relay) return relay
    const workspaceKey = process.env.RELAY_WORKSPACE_KEY
    if (!workspaceKey) {
        warn("RELAY_WORKSPACE_KEY missing: running with in-process delivery only")
        return null
    }
    try {
        relay = new AgentRelay({ workspaceKey, onError: (e: any) => warn("listener error:", errMsg(e)) } as any)
        relay.addListener("*", (ev: any) => onRelayEvent(ev))
    } catch (e) {
        warn("AgentRelay init failed:", errMsg(e))
        relay = null
    }
    return relay
}

const isConflict = (e: any) => e?.code === "name_conflict" || e?.status === 409 || e?.statusCode === 409 || /name_conflict|already exists/i.test(String(e?.message))

async function connectAgent(agentId: string): Promise<Client | null> {
    const r = getRelay()
    if (!r) return null
    const saved = loadStore().agents[agentId]
    const t0 = Date.now()
    if (saved?.token) {
        try {
            const c = await withRetry(`reconnect ${agentId}`, () => r.workspace.reconnect({ apiToken: saved.token }))
            relayLog({ op: "reconnect", agentId, name: saved.name, ms: Date.now() - t0 })
            return c
        } catch (e) {
            warn(`reconnect ${agentId} (${saved.name}) failed: ${errMsg(e)}; registering`)
        }
    }
    const register = async (name: string) => {
        const c = (await withRetry(`register ${name}`, () => r.workspace.register({ name, type: "agent" } as any))) as unknown as Client
        if (c.token) saveAgent(agentId, c.name ?? name, c.token)
        else warn(`register ${name}: no token on client; restart will need a suffixed name`)
        relayLog({ op: "register", agentId, name: c.name ?? name, ms: Date.now() - t0 })
        return c
    }
    const base = AGENT_PREFIX + agentId
    const preferred = saved?.name ?? base
    try {
        return await register(preferred)
    } catch (e) {
        if (!isConflict(e)) throw e
        const name = `${base}-${Date.now().toString(36)}`
        warn(`name ${preferred} taken without a saved token; registering as ${name}`)
        return await register(name)
    }
}

// Logical agent id ("investigator", "site", "cam-1", "guest-7f3a") -> live client. Memoized; never throws.
function agent(agentId: string): Promise<Client | null> {
    let p = clients.get(agentId)
    if (!p) {
        p = connectAgent(agentId).catch(e => {
            warn(`agent ${agentId} unavailable:`, errMsg(e))
            clients.delete(agentId) // allow a later retry
            return null
        })
        clients.set(agentId, p)
    }
    return p
}

// Creates (if needed) and joins a channel for one agent. Memoized; never throws.
function joinChannel(agentId: string, channel: string, topic = ""): Promise<void> {
    const key = `${agentId}:${channel}`
    let p = channelReady.get(key)
    if (!p) {
        p = (async () => {
            const c = await agent(agentId)
            if (!c) return
            try {
                await withRetry(`create #${channel}`, () => c.channels.create({ name: channel, topic } as any))
                relayLog({ op: "create-channel", channel, by: agentId })
            } catch (e: any) {
                if (!isConflict(e) && !/exist/i.test(String(e?.message))) warn(`create #${channel}:`, errMsg(e))
            }
            try {
                await withRetry(`join #${channel}`, () => c.channels.join(channel))
            } catch (e: any) {
                if (!/already|member/i.test(String(e?.message))) warn(`${agentId} join #${channel}:`, errMsg(e))
            }
        })().catch(e => {
            channelReady.delete(key)
            warn(`joinChannel ${key}:`, errMsg(e))
        })
        channelReady.set(key, p)
    }
    return p
}

async function waitRelayId(bodyId: string, timeoutMs: number): Promise<string | null> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        const id = relayIds.get(bodyId)
        if (id) return id
        const p = sendPromises.get(bodyId)
        if (p) return await Promise.race([p, sleep(end - Date.now()).then(() => null)])
        await sleep(250)
    }
    return relayIds.get(bodyId) ?? null
}

function relayTarget(to: string) {
    return to.startsWith("@") ? `@${relayNameOf(to.slice(1))}` : to
}

function relaySend(body: Body): Promise<string | null> {
    const text = JSON.stringify(body)
    const p = (async () => {
        const c = await agent(body.from)
        if (!c) return null
        if (body.to.startsWith("#")) await joinChannel(body.from, body.to.slice(1))
        // Testimony goes in the question's thread when we know the question's Relay id.
        const parent = body.kind === "testimony" && body.threadOf ? await waitRelayId(body.threadOf, 30_000) : null
        const t0 = Date.now()
        try {
            const res: any = await withRetry(`send ${body.kind} ${body.id}`, () =>
                parent ? c.reply({ messageId: parent, text }) : c.sendMessage({ to: relayTarget(body.to), text })
            )
            const mid = res?.messageId ?? res?.id ?? null
            if (mid) relayIds.set(body.id, mid)
            relayLog({ op: "send", id: body.id, kind: body.kind, from: body.from, to: body.to, thread: !!parent, sendMs: Date.now() - t0, sinceCreatedMs: Date.now() - body.sentAt, ok: true })
            return mid
        } catch (e) {
            relayLog({ op: "send", id: body.id, kind: body.kind, from: body.from, to: body.to, sendMs: Date.now() - t0, ok: false, err: errMsg(e) })
            warn(`send ${body.kind} ${body.from}->${body.to} failed:`, errMsg(e))
            return null
        }
    })()
    sendPromises.set(body.id, p)
    return p
}

function onRelayEvent(ev: any) {
    try {
        const m = ev?.message
        const text: string | undefined = m?.text
        if (!text || text[0] !== "{") return
        let body: Body
        try {
            body = JSON.parse(text)
        } catch {
            return
        }
        if (!body?.id || !body.kind || !body.sentAt) return
        if (body.sentAt < PROCESS_START - 5_000) return // history from an earlier run
        const mid = m.messageId ?? m.id
        if (mid && !relayIds.has(body.id)) relayIds.set(body.id, mid)
        if (!delivered.has(body.id)) {
            delivered.add(body.id)
            relayLog({ op: "deliver", id: body.id, kind: body.kind, from: body.from, to: body.to, event: ev.type, deliveryMs: Date.now() - body.sentAt, alreadyLocal: dispatched.has(body.id) })
        }
        dispatch(body, "relay") // no-op when local delivery already ran it
    } catch (e) {
        warn("onRelayEvent:", errMsg(e))
    }
}

// ---------------------------------------------------------------- bus

function summarize(body: Body): string {
    switch (body.kind) {
        case "question":
            return body.ask
        case "testimony": {
            const claims: Claim[] = body.claims ?? []
            if (!claims.length) return "I saw nothing in that window."
            return `${claims.length} claim${claims.length > 1 ? "s" : ""}: ${claims.map(c => `[${clock(c.t)}] ${c.text}`).join(" · ")}`
        }
        case "reexamine":
            return `Re-check privately: "${body.claimA}" vs "${body.claimB}". ${body.ask}`
        case "answer":
            if (body.operator) return body.text
            return `${body.stance} (confidence ${Math.round((body.confidence ?? 0) * 100)}%)`
        case "alert":
            return `${body.alert?.camId}: ${body.alert?.text}`
        case "knock":
            return `${body.guestId} knocks: ${body.offer}`
        case "admit":
            return `${body.guestId} admitted to #incident-${String(body.incId).replace(/^inc-/, "")}`
        case "verdict":
            return body.summary
    }
    return ""
}

// Sends one message: card first (instant), local delivery (instant), Relay in the background.
function send(from: string, to: string, payload: { kind: RelayKind; incId?: string; threadOf?: string; [k: string]: any }): Body {
    const body: Body = { id: newId(payload.kind), from, to, sentAt: Date.now(), ...payload }
    const card: RelayCard = { id: body.id, kind: body.kind, from, to, text: summarize(body), t: body.sentAt }
    if (body.threadOf) card.threadOf = body.threadOf
    if (body.incId) card.incId = body.incId
    void safePublish({ type: "relay", card })
    if (body.incId) void incident(body.incId).logRelay(card).catch(e => warn("logRelay:", errMsg(e)))
    void relaySend(body)
    if (localDelivery()) dispatch(body, "local")
    return body
}

function dispatch(body: Body, via: "local" | "relay") {
    if (dispatched.has(body.id)) return
    dispatched.add(body.id)
    const run = async () => {
        switch (body.kind) {
            // Only act for agents and incidents this process runs (another process may share the workspace).
            case "question":
                // Operator question (no incident): one camera answers @operator. Incident questions go to body.targets.
                if (body.operator) return clients.has(body.target) || via === "local" ? onOperatorQuestion(body.target, body) : undefined
                for (const camId of body.targets ?? []) if (clients.has(camId) || via === "local") void onQuestion(camId, body)
                return
            case "testimony":
                return body.incId && active.has(body.incId) ? onTestimony(body) : undefined
            case "reexamine":
                return clients.has(body.target) || via === "local" ? onReexamine(body.target, body) : undefined
            case "answer":
                return onAnswer(body)
            default:
                return // alert / knock / admit / verdict: informational cards
        }
    }
    run().catch(e => warn(`handler ${body.kind} (${via}):`, errMsg(e)))
}

// ---------------------------------------------------------------- witnesses (camera agents)

async function onQuestion(camId: string, q: Body) {
    const [t0, t1] = q.window as [number, number]
    const obs = await recall(camId, t0, t1)
    let testimony: Testimony
    try {
        testimony = await witnessTestimony(camId, [t0, t1], q.ask, obs) // zero claims when the LLM is unavailable
    } catch (e) {
        warn(`${camId} testimony failed:`, errMsg(e))
        testimony = { camId, claims: [] }
    }
    send(camId, q.to, { kind: "testimony", incId: q.incId, threadOf: q.id, camId, claims: testimony.claims })
}

async function onReexamine(camId: string, q: Body) {
    const [t0, t1] = q.window as [number, number]
    const obs = await recall(camId, t0, t1)
    let a: ReexamineAnswer
    try {
        a = await witnessReexamine(camId, q.claimA, q.claimB, q.ask, obs)
    } catch (e) {
        warn(`${camId} reexamine LLM failed:`, errMsg(e))
        a = { camId, stance: "I could not re-check my record.", supports: "unsure", confidence: 0, frameRef: "" }
    }
    send(camId, "@investigator", { kind: "answer", incId: q.incId, threadOf: q.id, contradictionId: q.contradictionId, ...a })
}

async function onOperatorQuestion(camId: string, q: Body) {
    const [t0, t1] = q.window as [number, number]
    const obs = await recall(camId, t0, t1) // works offline too: the camera answers from memory
    let a: { text: string; claims: Claim[] }
    try {
        a = await witnessAsk(camId, q.ask, [t0, t1], obs)
    } catch (e) {
        warn(`${camId} ask failed:`, errMsg(e))
        a = { text: "I couldn't check my memory just now.", claims: [] }
    }
    send(camId, "@operator", { kind: "answer", operator: true, threadOf: q.id, camId, question: q.ask, text: a.text, claims: a.claims })
}

const askWaiters = new Map<string, (r: AskResult) => void>() // operator question id -> resolver

// ---------------------------------------------------------------- investigator

const answerWaiters = new Map<string, (a: ReexamineAnswer) => void>() // reexamine id -> resolver

async function onTestimony(body: Body) {
    if (!body.incId) return
    const t: Testimony = { camId: body.camId, claims: body.claims ?? [] }
    const inc = await incident(body.incId).addTestimony(t)
    await publishIncident(body.incId, inc)
}

function onAnswer(body: Body) {
    if (body.operator) {
        const w = body.threadOf ? askWaiters.get(body.threadOf) : undefined
        if (w) w({ camId: body.camId, question: body.question, text: body.text, claims: body.claims ?? [] })
        return
    }
    const w = body.threadOf ? answerWaiters.get(body.threadOf) : undefined
    if (w) w({ camId: body.camId, stance: body.stance, supports: body.supports, confidence: body.confidence, frameRef: body.frameRef })
}

// Waits until every camera in camIds has answered or gone silent, or the deadline passes.
async function gather(incId: string, camIds: string[], deadlineMs = TESTIMONY_DEADLINE_MS + 500): Promise<IncidentState | null> {
    const end = Date.now() + deadlineMs
    let lastSilent = 0
    let inc: IncidentState | null = null
    while (true) {
        try {
            inc = await incident(incId).get()
        } catch (e) {
            warn(`${incId}: get failed (${errMsg(e)}); retrying`)
            await sleep(1000)
            if (Date.now() > end) return inc
            continue
        }
        if (!inc) return null
        const mine = inc.witnesses.filter(w => camIds.includes(w.camId))
        const silent = mine.filter(w => w.status === "silent").length
        if (silent !== lastSilent) {
            lastSilent = silent
            await publishIncident(incId, inc)
        }
        if (mine.every(w => w.status !== "asked")) return inc
        if (Date.now() > end) {
            log(`${incId}: deadline passed with ${mine.filter(w => w.status === "asked").map(w => w.camId).join(", ")} still asked`)
            return inc
        }
        await sleep(400)
    }
}

function askText(question: string, window: [number, number]) {
    return `${question} Tell me everything you saw between ${clock(window[0])} and ${clock(window[1])}: who was there, what they wore, what they did, and where they entered or left your view.`
}

async function question(incId: string, inc: IncidentState, targets: string[]) {
    const chan = `incident-${incId.replace(/^inc-/, "")}`
    // Channel setup runs in the background; local delivery does not wait for it.
    void joinChannel("investigator", chan, inc.question).then(() => Promise.all(targets.map(c => joinChannel(c, chan))))
    send("investigator", `#${chan}`, { kind: "question", incId, window: inc.window, ask: askText(inc.question, inc.window), targets })
}

// Cross-examines both cameras of each unresolved contradiction privately; returns their answers.
async function crossExamine(incId: string, inc: IncidentState, cs: AnalysisOutput["contradictions"], witnesses: string[]) {
    const rounds = await Promise.all(
        cs.map(async c => {
            const cams = c.cams.filter(cam => witnesses.includes(cam))
            const answers = await Promise.all(
                cams.map(cam => {
                    const other = cam === c.cams[0] ? c.cams[1] : c.cams[0]
                    return new Promise<ReexamineAnswer | null>(resolve => {
                        const b = send("investigator", `@${cam}`, {
                            kind: "reexamine", incId, target: cam, contradictionId: c.id, window: inc.window,
                            claimA: `${c.cams[0]}: ${c.a}`, claimB: `${c.cams[1]}: ${c.b}`, ask: `${c.ask} (${other} says otherwise.)`
                        })
                        const timer = setTimeout(() => {
                            answerWaiters.delete(b.id)
                            resolve(null)
                        }, ANSWER_DEADLINE_MS)
                        answerWaiters.set(b.id, a => {
                            clearTimeout(timer)
                            answerWaiters.delete(b.id)
                            resolve(a)
                        })
                    })
                })
            )
            return { contradictionId: c.id, answers: answers.filter(Boolean) as ReexamineAnswer[] }
        })
    )
    return rounds.filter(r => r.answers.length)
}

const strip = (cs: AnalysisOutput["contradictions"]): Contradiction[] => cs.map(({ ask: _a, ...c }) => c)

// Analyse all testimony (+ previous timeline), cross-examine, finalize, post the verdict.
async function analyseAndFinalize(incId: string, newWitness?: string): Promise<{ changed: string[]; output: AnalysisOutput | null }> {
    let inc = await incident(incId).setStatus("analysing")
    await publishIncident(incId, inc)
    const [t0, t1] = inc.window
    const [paths, layout, testimonyMap] = await Promise.all([sitePaths(t0, t1), siteLayout(), incident(incId).getTestimony()])
    const testimonies = Object.values(testimonyMap)
    const chan = `#incident-${incId.replace(/^inc-/, "")}`

    if (!hasLLM()) {
        warn(`${incId}: OPENAI_API_KEY missing: investigator offline`)
        const r = await incident(incId).setResult({ timeline: inc.timeline, contradictions: inc.contradictions, paths, summary: "Investigator offline: no API key" })
        await publishIncident(incId, r.incident, r.changed)
        send("investigator", chan, { kind: "verdict", incId, summary: "Investigator offline: no API key" })
        return { changed: r.changed, output: null }
    }

    if (!testimonies.some(t => t.claims.length) && !inc.timeline.length) {
        const summary = "No camera answered before the deadline, so there is nothing to cite yet."
        const r = await incident(incId).setResult({ timeline: [], contradictions: [], paths, summary })
        await publishIncident(incId, r.incident, r.changed)
        send("investigator", chan, { kind: "verdict", incId, summary })
        return { changed: [], output: null }
    }

    const allChanged = new Set<string>()
    let out: AnalysisOutput
    try {
        out = await analyse({ question: inc.question, window: inc.window, testimonies, paths, layout, previous: inc.timeline, previousContradictions: inc.contradictions, newWitness })
    } catch (e) {
        warn(`${incId}: analysis failed:`, errMsg(e))
        const summary = e instanceof NoLLMError ? "Investigator offline: no API key" : `Investigator error: ${errMsg(e)}`
        const r = await incident(incId).setResult({ timeline: inc.timeline, contradictions: inc.contradictions, paths, summary })
        await publishIncident(incId, r.incident, r.changed)
        send("investigator", chan, { kind: "verdict", incId, summary })
        return { changed: [], output: null }
    }
    const unresolved = out.contradictions.filter(c => !c.resolution).slice(0, 1) // one cross-examination round keeps the demo readable
    let r = await incident(incId).setResult({ timeline: out.timeline, contradictions: strip(out.contradictions), paths, summary: out.summary, status: unresolved.length ? "analysing" : "done" })
    r.changed.forEach(id => allChanged.add(id))
    await publishIncident(incId, r.incident, r.changed)

    if (unresolved.length) {
        const witnesses = r.incident.witnesses.map(w => w.camId)
        const answers = await crossExamine(incId, r.incident, unresolved, witnesses)
        const resolved = answers.length
            ? await resolveContradictions({ question: inc.question, timeline: out.timeline, contradictions: strip(out.contradictions), answers, summary: out.summary })
            : null
        if (resolved) {
            const asks = new Map(out.contradictions.map(c => [c.id, c.ask]))
            out = { ...out, timeline: resolved.timeline, summary: resolved.summary, contradictions: resolved.contradictions.map(c => ({ ...c, ask: asks.get(c.id) ?? "" })) }
        } else warn(`${incId}: contradictions left unresolved (no answers or resolution failed)`)
        r = await incident(incId).setResult({ timeline: out.timeline, contradictions: strip(out.contradictions), paths, summary: out.summary })
        r.changed.forEach(id => allChanged.add(id))
        await publishIncident(incId, r.incident, r.changed)
    }
    send("investigator", chan, { kind: "verdict", incId, summary: out.summary, revision: r.incident.revision })
    return { changed: [...allChanged], output: out }
}

// One investigation step at a time per incident (an admit can arrive mid-run).
const locks = new Map<string, Promise<unknown>>()
function serialize<T>(incId: string, fn: () => Promise<T>): Promise<T> {
    active.add(incId)
    const prev = locks.get(incId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(incId, next)
    return next
}

// ---------------------------------------------------------------- exports

let started: Promise<void> | null = null

export async function startRelay(): Promise<void> {
    try {
        started ??= (async () => {
            const t0 = Date.now()
            if (!getRelay()) return
            await Promise.all([joinChannel("investigator", "site", "Site alerts"), joinChannel("site", "site", "Site alerts")])
            log(`ready in ${Date.now() - t0}ms (local delivery ${localDelivery() ? "on" : "OFF"})`)
        })().catch(e => warn("startRelay:", errMsg(e)))
        await started
    } catch (e) {
        warn("startRelay:", errMsg(e))
    }
}

// Registers (or reconnects) the camera's Relay agent and joins #site.
export async function ensureCameraAgent(camId: string): Promise<void> {
    try {
        if (camId.startsWith("guest-")) await agent(camId) // outside agents knock; they don't sit in #site
        else await joinChannel(camId, "site")
    } catch (e) {
        warn(`ensureCameraAgent ${camId}:`, errMsg(e))
    }
}

// Camera agent posts an alert to #site.
export async function postAlert(alert: Alert): Promise<void> {
    try {
        void ensureCameraAgent(alert.camId)
        send(alert.camId, "#site", { kind: "alert", alert })
    } catch (e) {
        warn("postAlert:", errMsg(e))
    }
}

// Runs the questioning loop for an opened incident. Fire-and-forget from the server.
// If the incident is not open yet, opens it (opts, else last 60s with every admitted camera).
export async function runInvestigation(incId: string, opts?: { question?: string; window?: [number, number]; camIds?: string[] }): Promise<void> {
    try {
        await serialize(incId, async () => {
            let inc = await incident(incId).get()
            if (!inc) {
                const cams = opts?.camIds ?? (await actors.SiteActor.get("site").listCameras().catch(() => [])).filter(c => c.kind === "fixed" || c.admitted).map(c => c.id)
                const now = Date.now()
                inc = await incident(incId).open(opts?.question ?? "What happened?", opts?.window ?? [now - 60_000, now], cams)
            }
            await publishIncident(incId, inc)
            const targets = inc.witnesses.filter(w => w.status === "asked").map(w => w.camId)
            const t0 = Date.now()
            log(`${incId}: questioning ${targets.join(", ")}`)
            await question(incId, inc, targets)
            await gather(incId, targets)
            log(`${incId}: gathered in ${Date.now() - t0}ms`)
            await analyseAndFinalize(incId)
            log(`${incId}: done in ${Date.now() - t0}ms`)
        })
    } catch (e) {
        warn(`runInvestigation ${incId}:`, errMsg(e))
    }
}

// Guest agent knocks on @site with its offer.
export async function sendKnock(guestId: string, offer: string): Promise<void> {
    try {
        void agent(guestId)
        send(guestId, "@site", { kind: "knock", guestId, offer })
    } catch (e) {
        warn("sendKnock:", errMsg(e))
    }
}

// Operator approved: add the guest to the incident, question it, revise the verdict.
export async function admitWitness(guestId: string, incId: string): Promise<void> {
    try {
        await serialize(incId, async () => {
            const chan = `incident-${incId.replace(/^inc-/, "")}`
            void ensureCameraAgent(guestId)
            send("site", `#${chan}`, { kind: "admit", incId, guestId })
            const inc = await incident(incId).addWitness(guestId)
            await publishIncident(incId, inc)
            await question(incId, inc, [guestId])
            const after = await gather(incId, [guestId])
            const { changed, output } = await analyseAndFinalize(incId, guestId)
            const said = (await incident(incId).getTestimony().catch(() => ({} as Record<string, Testimony>)))[guestId]
            let message: string
            if (!said || after?.witnesses.find(w => w.camId === guestId)?.status === "silent") message = "Thanks — we couldn't read your clip in time, but the case stays open."
            else if (!said.claims.length) message = "Thanks — your clip didn't show anything in the incident window."
            else if (output?.guestNote) message = output.guestNote
            else message = changed.length ? `Thanks — your clip changed ${changed.length} point${changed.length > 1 ? "s" : ""} of the timeline.` : "Thanks — your clip confirmed what the other cameras saw."
            try {
                const site = actors.SiteActor.get("site")
                const existing = await site.getKnock(guestId)
                const knock = await site.putKnock({ guestId, offer: existing?.offer ?? "", ...existing, status: "done", message })
                await safePublish({ type: "knock", knock })
            } catch (e) {
                warn("putKnock:", errMsg(e))
            }
        })
    } catch (e) {
        warn(`admitWitness ${guestId} ${incId}:`, errMsg(e))
    }
}

// Operator asks one camera a question over Relay ("Ask this camera"). Resolves when the answer exists
// (local delivery: no Relay wait). Never throws; 25s timeout.
export async function askCamera(camId: string, question: string): Promise<AskResult> {
    const q = String(question ?? "").trim() || "What did you see?"
    try {
        void agent("operator")
        void agent(camId)
        const now = Date.now()
        return await new Promise<AskResult>(resolve => {
            let id = ""
            const timer = setTimeout(() => {
                askWaiters.delete(id)
                resolve({ camId, question: q, text: "I couldn't answer in time.", claims: [] })
            }, 25_000)
            // Register the waiter before local delivery can answer.
            id = newId("question")
            askWaiters.set(id, r => {
                clearTimeout(timer)
                askWaiters.delete(id)
                resolve({ ...r, camId, question: q })
            })
            send("operator", `@${camId}`, { id, kind: "question", operator: true, target: camId, ask: q, window: [now - 10 * 60_000, now] })
        })
    } catch (e) {
        warn(`askCamera ${camId}:`, errMsg(e))
        return { camId, question: q, text: "I couldn't answer just now.", claims: [] }
    }
}

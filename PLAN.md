# Panoramal Activity: Architecture and 3-Hour Build Plan

**One-liner:** Every camera is a witness. When something happens, an investigator agent questions them, compares their accounts and works out what happened, citing a camera and timestamp for every claim.

**Sponsors:**

- **Terse:** each camera, person, site and incident is a durable actor with its own memory and alarm.
- **Agent Relay:** witnesses, the investigator and outside phones talk to each other as agents. A late witness joins by knocking on the site's address.

**Fastest path:** one laptop runs everything. One public HTTPS URL through a Cloudflare tunnel, three pages, phones join by QR code, nothing to install. No Vercel: the Relay bridge and the Terse runtime need processes that stay running (section 9).

---

## 1. What we demo (2 minutes)

| Time | On screen | What it proves |
| ---- | --------- | -------------- |
| 0:00 | Three phones on stands around the stage scan a QR code. Each appears on the floor plan as an unconnected node. | One actor per camera |
| 0:15 | **Calibration walk.** A teammate walks around the room, and the links between cameras appear one at a time, with transit times. One exit lights up red as a **blind spot**. | Cameras learn the room's layout together (Terse + Relay) |
| 0:35 | **Incident.** Someone walks in, takes a bag off the table and leaves through the blind spot. | |
| 0:50 | Click **"What just happened?"** Relay messages stream down the middle panel: the investigator's questions and each camera's answer. The timeline fills in. | Investigator works over Relay; testimony comes from each actor's memory |
| 1:10 | **Contradiction.** One camera says "black jacket," another says "navy." The investigator questions both against their frames and settles it. | Cross-examination |
| 1:25 | **Late witness.** An audience member scans the "Saw something?" QR code and uploads a clip. It knocks; we approve. The clip is aligned by matching events, the dashed (inferred) part of the path turns solid and the verdict changes. | Durable incident + Relay knock |
| 1:45 | **Report.** Every sentence links to a camera and timestamp; clicking one shows the frame. | Provenance |

**Pitch frame:** warehouse and workplace safety (near-misses, falls, theft from a shared space). The cameras belong to the site, so there's no concern about watching the public.

---

## 2. User flows

Everything is in the browser. There are three roles, and each gets one page.

| Page | Who | Where it runs |
|---|---|---|
| `/dash` | Operator (safety lead, site manager) | Demo laptop, on the projector |
| `/capture` | A camera phone | Phone on a stand, reached by QR code |
| `/witness` | A guest with footage | Anyone's phone, reached by a second QR code |

### Operator (`/dash`)

1. **Empty state:** a large "Scan to add a camera" QR code over a blank floor-plan grid. The operator can drop in a photo or sketch of the room as the background.
2. **Cameras join:** each phone appears as a coloured node, and the operator **drags it into place** and sets its facing direction. Each camera keeps its colour on every screen.
3. **Learn layout:** the operator clicks **Learn layout** and someone walks around. Links draw themselves in with transit times, and blind spots pulse red.
4. **Incident:** the operator clicks **What just happened?** (the last 60 seconds by default), or accepts an alert the system suggests ("cam-table: bag picked up"). They can type a question ("Who took the bag?").
5. **Watch it work:** the middle panel streams Relay messages as cards (question → testimony in threads → re-examination). The right panel builds the timeline, and the map plays the path: solid where a camera saw it, dashed where it's inferred.
6. **Knock:** a toast reads "guest-7f3a wants to add footage (14:03:00–14:03:30)" with **Approve / Deny**.
7. **Report:** every claim has camera-coloured citation chips. Clicking a chip opens the frame with the person's bounding box drawn on it. Revised claims show a **Revised** badge with the old claim struck through.
8. **Follow-up:** a chat box at the bottom of the timeline ("Where did the person in red go after?") sends a new question to the investigator.

### Camera phone (`/capture`)

1. Scan the QR code → `/capture` opens → **Allow camera**.
2. The camera preview fills the screen with a status pill over it: *"Witnessing as cam-2 · 48 observations · synced ±12 ms."* The pill pulses each time a frame is sent.
3. The screen stays on (Wake Lock API). If the page goes to the background, the pill turns amber: *"Keep this page open."* iOS stops the camera in background tabs.
4. That's all the user does. Unplugging or locking the phone turns its node grey on the dashboard, and its memory stays.

### Guest witness (`/witness`)

1. Scan the **"Saw something? Add your footage"** QR code, shown on the dashboard's side rail or on a printed sign.
2. Two large buttons: **Upload a clip** (the phone's file picker, which opens the gallery) or **Record now** (works like `/capture`).
3. Upload: the browser extracts 1 frame per second (a `<video>` element drawn to a canvas) and shows a progress ring. The server never needs ffmpeg.
4. Waiting: *"Asking the site to accept your footage…"* This is the Relay knock.
5. Approved: *"Analysing… your clip is being questioned."*
6. Result card: *"Thanks. Your clip covered a 15-second gap near the hallway door."* The page polls `/api/witness/:id` for this.

---

## 3. System at a glance

```
 Phones (/capture, /witness)                    Laptop: /dash (localhost)
   │  HTTPS via cloudflared tunnel              ▲ Terse websockets (Site + Incident broadcasts)
   │  1 fps JPEG, motion-gated                  │
   ▼                                            │
 ┌──────────────────────── Bun server :3000 ───────────────────────────┐
 │  serves web/dist   /api/time   /api/ingest   /api/witness   /frames │
 │                                                                     │
 │  /api/ingest ──► vision (Haiku) ──► CameraActor.ingest() ──► events │
 │                    exits/entries ─────► SiteActor.recordExit/Entry  │
 │                    sightings ─────────► EntityActor.addSighting     │
 │                                                                     │
 │  Relay bridge: one Relay agent per camera + investigator + site     │
 │     witness agent  ◄── question ──  investigator (Sonnet)           │
 │          │ CameraActor.recall()            │ IncidentActor.*       │
 └─────────────────────────────────────────────────────────────────────┘
          Terse runtime (durable-actors dev): Camera / Entity / Site / Incident
```

**Rules:**

- Actors hold state, order, alarms and broadcasts. **LLM calls happen in the server or Relay bridge, never inside an actor method.** Terse actors handle one request at a time, so a 2-second LLM call would block that camera's ingest.
- **Every live update reaches the dashboard through a Terse broadcast.** The bridge copies each Relay message into `IncidentActor.logRelay()` (or `SiteActor.logRelay()` for handoffs and alerts), which also makes the actor's transcript the permanent record. The dashboard needs only two websockets.
- The dashboard runs on the laptop, so Terse websocket URLs stay on `localhost`. Phones only make HTTP calls to `/api` through the tunnel.

---

## 4. Terse actors (key functions)

API confirmed from the docs: `class X extends Actor<Metadata, Incoming, Outgoing>`, `@Persisted` fields, `this.alarm.set(ts)` + `onAlarm()`, `this.broadcast(msg, { tags })`, and `actors.X.get(id).method()` from the backend. Actor-to-actor calls aren't documented, so **the server forwards events between actors.**

### `CameraActor` (id = `cam-door`, `cam-table`, `guest-7f3a`, …): the witness

| Persisted | |
|---|---|
| `meta` | `{ name, kind: "fixed" \| "upload", color, mapPos, facing, reliability }` |
| `log: Observation[]` | Rolling, last ~10 minutes |
| `visible: Map<entityId, lastSeen>` | Who is in frame right now |
| `offset: { ms, ± }` | Clock offset and how sure we are of it (section 6) |
| `online: boolean` | |

| Method | What it does | Why Terse |
|---|---|---|
| `ingest(obs)` | Appends to the log. Compares with `visible` and returns `{ entries, exits }`: an entity counts as exited when it's gone for 2 frames, at the edge where it was last seen. Re-arms the alarm. | One request at a time gives a strictly ordered log per camera |
| `recall(t0, t1)` | Returns the observations in the window, with the offset applied. The bridge LLM turns them into testimony. | Memory outlives the stream: ask it after the phone has disconnected |
| `frame(ref)` | Returns the stored keyframe path for re-examination | |
| `setOffset(ms, ±)` | Updates the clock offset when alignment improves | |
| `onAlarm()` | Fires 5s after the last frame: sets `online = false`, flushes pending exits, broadcasts `camera-offline` | **Alarm = heartbeat.** Unplug a phone on stage; its node goes grey, and its memory remains |

### `EntityActor` (id = `A`, `B`, …): one per tracked person or object

| Method | What it does | Why Terse |
|---|---|---|
| `addSighting({ t, camId, x, edge, desc, action })` | Appends a sighting and updates the merged description | Sightings from several cameras arrive at once; serialized, so the path never interleaves |
| `path(t0, t1)` | Sightings in order, plus gaps marked `inferred` (filled using the site's links) | |

### `SiteActor` (id = `site`): the directory and learned layout

| Persisted | |
|---|---|
| `cameras` | ids, colours, positions on the map, online status |
| `pendingExits` | `{ entityId, camId, edge, t }[]`, waiting to be matched |
| `edges` | `{ from: camId+edge, to: camId+edge, transits: number[] }[]` |
| `blindSpots` | exit edges where people leave and never reappear |
| `knownEntities` | descriptions, sent to the vision prompt for re-identification |
| `pendingKnocks` | guests waiting for Approve / Deny |

| Method | What it does | Why Terse |
|---|---|---|
| `addCamera(meta)` / `moveCamera(id, pos, facing)` | Registers a camera and its colour; the operator drags it on the map | |
| `recordExit(e)` | Adds the exit to `pendingExits` and sets the alarm for 20s later | |
| `recordEntry(e)` | Matches against pending exits for the same entity, adds a transit to the link and broadcasts `edge-added` / `edge-updated` | **Serialized**, so one exit can't be matched to two entries |
| `onAlarm()` | Unmatched exits older than 20s count toward a blind spot on that edge (1 for the demo, 3 normally). Broadcasts `blind-spot`. Re-arms if more exits are pending. | **Alarm = the blind-spot detector** |
| `neighbours(camId, edge)` | Returns the expected next camera and transit time (used for handoff messages) | |
| `knock(guest)` / `decide(guestId, ok)` | Queues a guest's knock and broadcasts it as a toast; records the operator's decision | One decision per knock, even if the button is clicked twice |
| `openIncident(q)` | Called on an alert or button press. Returns a new incident id. | |
| `logRelay(msg)` | Broadcasts handoffs and alerts to the dashboard | |

The layout gets better over time and survives restarts, which is part of the pitch: a site that has run for a week knows its own layout.

### `IncidentActor` (id = `inc-<n>`): the case

| Persisted | |
|---|---|
| `question`, `window: [t0, t1]` | |
| `witnesses` | `{ camId, status: "asked" \| "answered" \| "silent", testimony[] }` |
| `timeline` | `TimelineItem[]` |
| `contradictions` | `{ claimA, claimB, status }[]` |
| `revisions` | earlier timelines, so the dashboard can show what changed |
| `transcript` | every Relay message in this case |

| Method | What it does | Why Terse |
|---|---|---|
| `open(q, window, camIds)` | Marks each witness `asked` and sets an alarm 6s out | |
| `addTestimony(camId, testimony)` | Records it and broadcasts `testimony` | Answers arrive at once; nothing is lost or counted twice |
| `setTimeline(tl, contradictions)` | Stores the investigator's output, keeps the previous version in `revisions` and broadcasts `timeline` along with what changed | |
| `addWitness(camId)` | A late witness. Reopens the case and asks the investigator to run again. | **Durable case:** new evidence arrives minutes later and the verdict is revised, not rebuilt |
| `logRelay(msg)` | Appends to `transcript` and broadcasts it as a card | The case's record of who said what |
| `onAlarm()` | Witnesses still `asked` become `silent`. Tells the investigator to proceed with what it has. | **Alarm = testimony deadline:** one dead camera can't stall the case |

---

## 5. Agent Relay (key functions)

SDK: `@agent-relay/sdk` v15 (`npm install @agent-relay/sdk zod`, Node 22+). Docs: [agentrelay.com/docs/typescript-sdk](https://agentrelay.com/docs/typescript-sdk), with markdown copies at [agentrelay.com/llms.txt](https://agentrelay.com/llms.txt).

```ts
import { AgentRelay } from '@agent-relay/sdk';

// once: const relay = await AgentRelay.createWorkspace({ name: 'panoramal-activity' }) → save relay.workspaceKey
const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY! });

const cam = await relay.workspace.register({ name: 'cam-door', type: 'agent' });   // one per CameraActor
await cam.channels.join('site');

const { messageId } = await investigator.sendMessage({ to: '#incident-1', text: JSON.stringify(question) });
await cam.reply({ messageId, text: JSON.stringify(testimony) });                    // answers go in the thread
await investigator.sendMessage({ to: '@cam-table', text: JSON.stringify(reexamine) });

relay.addListener('message.created', ({ message, envelope }) => { /* route by envelope.channel?.name / recipient */ });
```

Every message body is JSON (`{ kind: "question" | "testimony" | …, … }`), so the dashboard can show it as a card while it still reads as text in Relay's own UI.

All agents run in one process, the **Relay bridge** (`server/relay.ts`). It makes one `relay` client and one `addListener`, passes each message to the right agent and copies it to `logRelay()` on the right actor:

| Agent | Joins | Does |
|---|---|---|
| `cam-<id>` (one per camera, registered when its `CameraActor` is created) | `#site`, `#incident-*` | **Witness.** On a question, calls `CameraActor.recall()` and gives Haiku the observations plus the question. Replies **in the question's thread** with structured testimony. On a `reexamine` DM, loads the keyframe and makes one vision call. |
| `investigator` | `#incident-*` | **Questioning loop** (Sonnet), described below. Creates the `#incident-<n>` channel with `channels.create`. |
| `site` | `#site`, DMs | Receives knocks and passes them to `SiteActor.knock()`; on Approve, adds the guest to the incident channel |

**Threads:** each question is one message in `#incident-<n>`, and the witnesses answer in its thread. `threads.get(messageId)` returns the full exchange for that question, which is what the report cites.

### Channels and messages

| Where | Message | Sent by |
|---|---|---|
| `@cam-table` | `handoff { entityId, from: "cam-door", eta: 3.1 }` | camera that saw the exit (looked up with `SiteActor.neighbours`) |
| `#site` | `alert { camId, t, text: "bag picked up" }` | any camera whose vision result has `notable` set |
| `#incident-<n>` | `question { window, ask }` | investigator |
| thread reply | `testimony { camId, claims: [{ t, text, entityIds, frameRef, confidence }] }` | witnesses |
| `@cam-x` | `reexamine { frameRef, ask: "jacket colour: black or navy?" }` | investigator |
| `@site` | `knock { from: "guest-7f3a", offer: "clip 14:03:00–14:03:30" }` | an outside witness |

Handoff messages are partly for the audience: they make the camera-to-camera coordination visible on screen. A handoff that doesn't arrive by its ETA (+50%) also counts toward a blind spot.

### Late witness: knock and admit

Relay's access model: your team's agents talk freely, outside agents **knock** and the owner admits or refuses them, and everyone else gets no reply.

- **What we build (in scope):** `/witness` uploads frames to `/api/witness`. The server registers a `guest-<id>` agent, which DMs `@site` a `knock`. `SiteActor.knock()` makes the toast appear. On Approve, `site` adds the guest to `#incident-<n>`, the server creates `CameraActor(guest-<id>)` with `kind: "upload"`, aligns its clock (section 6) and `IncidentActor.addWitness()` runs.
- **Stretch, and a pitch line:** a *neighbouring business's* camera agent, owned by someone else, joins through **Relay Connect**. The host agent creates a temporary room at agentrelay.com/connect, which has an invite link, holds up to 8 participants and expires after 60 minutes by default. The neighbour's agent joins without getting our workspace key and answers questions about its own footage, and the footage never leaves its owner. Use the [Relay Connect docs](https://agentrelay.com/docs/relay-connect) and [forward deployed agents](https://agentrelay.com/docs/forward-deployed-agents) (public `arelay.to/<handle>` addresses). It's set up by a live agent session, not a code call, so demo it only if there's time to rehearse it.

### Optional: Relay actions
`relay.registerAction({ name: 'camera.recall', input: z.object({ camId, t0, t1 }), handler })` exposes a camera's memory as a typed tool that any Relay agent (including a Claude Code session) can call. It's useful for a "bring your own investigator" pitch line. Results arrive through `action.completed` listeners, not inline, so the core loop uses messages instead.

### Investigator loop

```
1. SiteActor → cameras online in the window  →  IncidentActor.open()
2. post #incident-n: question        (wait for testimony or the alarm deadline)
3. EntityActor.path() for every entity mentioned
4. Sonnet: testimony + paths + site links → { timeline, contradictions, gaps }
5. for each contradiction: DM both cameras a reexamine → update claims
6. IncidentActor.setTimeline()
7. when IncidentActor.addWitness() fires → back to step 2 with only the new camera
```

---

## 6. Time alignment

- **Live phones:** `/capture` calls `/api/time` five times and keeps `offset = serverT − (t0 + t1) / 2` from the fastest round trip. Accurate to tens of milliseconds, about 10 lines of code.
- **Guest clips (after the fact):** the clip was never synced. Start from the file's timestamp (often only whole seconds, and messaging apps can strip it), then **match events**. If the guest's vision output says "bag picked up" and cam-table's log has the same event, the gap between them is the offset (±0.5s at 1 fps). Write it with `CameraActor.setOffset()`.
- When two events fall within each other's uncertainty, the investigator says so ("can't tell whether A took the bag before B entered") instead of guessing the order.
- **Stretch:** audio cross-correlation for millisecond accuracy. This is how video editors sync multi-camera footage.

On stage: *"This clip was never synced. The system lined it up by matching what both cameras saw."*

---

## 7. Data shapes (`shared/types.ts`, write first)

```ts
type Edge = "left" | "right" | "top" | "bottom" | "center";

type Observation = {
  camId: string; t: number;            // server-synced ms
  frameRef: string;                    // frames/<camId>/<t>.jpg
  people: { id: string; desc: string; x: number; y: number; w: number; h: number; action: string }[];
  objects: { label: string; x: number; y: number; heldBy?: string }[];
  notable: string | null;              // "bag picked up" → alert
};

type Testimony = { camId: string; claims: { t: number; text: string; entityIds: string[]; frameRef: string; confidence: number }[] };

type TimelineItem = { id: string; t: number; claim: string; entityIds: string[];
  citations: { camId: string; t: number; frameRef: string }[];
  confidence: number; inferred: boolean; revisedFrom?: string };

// Everything the dashboard receives (Terse broadcasts). The front end builds against these.
type DashEvent =
  | { type: "camera-added" | "camera-moved" | "camera-offline" | "camera-online"; camera: CameraMeta }
  | { type: "observation"; camId: string; t: number; people: number }
  | { type: "edge-added" | "edge-updated"; edge: SiteEdge }
  | { type: "blind-spot"; camId: string; edge: Edge }
  | { type: "path"; entityId: string; points: PathPoint[] }
  | { type: "relay"; msg: RelayCard }
  | { type: "knock"; guestId: string; offer: string }
  | { type: "testimony"; camId: string; testimony: Testimony }
  | { type: "timeline"; items: TimelineItem[]; changed: string[] };
```

**Edge rule:** `x < 0.15 → left`, `x > 0.85 → right`, same idea for y, otherwise `center`. An exit is the edge where the person was last seen.

### Vision prompt (Haiku, one per frame)

> You are camera `{camId}`. Known people: `{A: "red hoodie, backpack", B: …}`. For this frame, return JSON matching `Observation` (omit camId/t/frameRef). Reuse a known id if the person matches; otherwise use `"new"`. Coordinates are 0–1 in the frame; give each person a bounding box. Set `notable` only for meaningful events (picks up or puts down an object, falls, runs, enters a restricted area).

The server assigns ids to `"new"` people and adds them to `SiteActor.knownEntities`. **This is how re-identification works**: the descriptions the model writes, matched by the model. It's good enough as long as people wear distinct clothes. The bounding boxes are drawn in the frame viewer.

---

## 8. Front end: polished, fast

### Stack
**Vite + React + TypeScript + Tailwind + shadcn/ui + `motion` (Framer Motion) + `lucide-react` + `qrcode.react`.** shadcn gives finished components (Dialog, Badge, Button, Card, ScrollArea, Sonner toasts) to style rather than build. `motion` covers every animation listed below in a few lines each. One Vite app with three routes; Bun serves the built `web/dist`.

### Build against a mock stream
`web/src/mock.ts` replays a JSON-lines file of `DashEvent`s with their real timing. The front-end owner builds and animates everything against it from minute 15, without waiting for the back end. At 1:20 it switches to the live websockets. During the freeze, **record a real run** into the mock file; that recording is the last-resort demo (section 11).

### Design direction
- **Projector first.** Design at 1920×1080 and test on the venue screen early. Body text 18px or larger, timestamps in a monospace font (JetBrains Mono), everything else in Inter. Use strong contrast, because projectors wash out subtle greys.
- **A control-room look:** dark neutral background, one accent colour for the investigator, and **one fixed colour per camera** (4 hues that are easy to tell apart). That colour is used everywhere the camera appears: map node, message-card avatar, citation chip, path segment, frame border. That consistency does most of the work of making it look polished.
- **Three panels, no navigation:** map (left, about 40%), Relay messages (middle), timeline (right). A header with the site name, camera count and the **What just happened?** button.

### Animations that sell the moments
| Moment | Animation |
|---|---|
| Camera joins | Node scales in with a ring pulse; QR panel shrinks into the side rail after the first camera |
| Link learned | Line draws from camera to camera (`pathLength` 0→1), then the transit time fades in on it |
| Blind spot | Red wedge at the exit edge, pulsing slowly |
| Camera offline | Node fades to grey and shows a "memory kept" tooltip |
| Relay message | Card slides in from the sender's side, with a typing shimmer while the witness's LLM runs |
| Timeline | Items stagger in; confidence shown as a thin bar |
| Revision | Changed item flashes, the old claim is struck through, a **Revised** badge appears, and the dashed path turns solid |
| Citation chip clicked | Frame opens in a dialog with the person's bounding box and the camera colour as the border |

### Phone pages
- **`/capture`:** full-screen camera, a frosted-glass status pill, a small pulse each time a frame is sent, the camera's colour as a thin border. Nothing else.
- **`/witness`:** two large buttons, a progress ring while frames are extracted, an animated waiting state for the knock, and a result card.

### Don't build
Log-in, settings, multiple sites, mobile layout for the dashboard, any routes beyond the three pages.

---

## 9. Repo layout and hosting

```
2026-ychh/panoramal-activity/
  actors/src/actors.ts      # CameraActor, EntityActor, SiteActor, IncidentActor
  server/index.ts           # Bun :3000 — serves web/dist, /api/time, /api/ingest, /api/witness, /api/config, /frames
  server/vision.ts          # Haiku per frame + response cache keyed by frame hash
  server/relay.ts           # Relay bridge: witnesses, investigator, site
  server/investigator.ts    # Sonnet prompts: testimony, timeline, re-examination
  server/align.ts           # event matching for guest clips
  shared/types.ts           # Observation, Testimony, TimelineItem, DashEvent
  web/                      # Vite app: /dash, /capture, /witness
    src/lib/capture.ts      # getUserMedia, motion gate, clock sync, frame extraction from video
    src/mock.ts             # replays recorded DashEvents
  fixtures/                 # pre-recorded clips, cached LLM outputs, recorded DashEvent stream
```

### Running it (fastest path)

```bash
bunx durable-actors dev                         # Terse runtime
bun --watch server/index.ts                     # API, Relay bridge, serves web/dist
cd web && bunx vite build --watch               # phones get the latest build
cloudflared tunnel --url http://localhost:3000  # public HTTPS URL for phones
```

- **One origin:** Bun serves both the pages and `/api`, so there's no CORS and only one tunnel.
- **Keep `cloudflared` running all day.** Its URL stays the same while it runs, even across server restarts. Put it in `PUBLIC_URL`; `/api/config` passes it to the dashboard, which builds its QR codes from it, because the dashboard itself is on `localhost`.
- While building, the front-end owner can use `vite dev` with a proxy to `:3000` on their own laptop, in mock mode.
- **Phones need HTTPS for the camera.** The tunnel provides it. Test on a real iPhone and a real Android in the first 20 minutes.
- **Venue network:** bring a phone hotspot. Laptop and phones go on it.
- **Motion gate:** compare a 32×24 downscaled canvas with the previous frame and only send when it changed enough. Also send at least one frame every 3s, as a heartbeat.
- **Models:** `claude-haiku-5-5` for frames and testimony, `claude-sonnet-5-5` for the investigator (fast enough to watch live). Use Opus only if the timeline quality is weak.

---

## 10. Build plan: 3 hours, 3 people

| Time | A: Capture + cameras + site | B: Front end (owns the polish) | C: Relay + investigator |
|---|---|---|---|
| **0:00–0:15** | **Everyone:** agree `shared/types.ts`, including `DashEvent`. Then A: `durable-actors init`, Bun server, tunnel, phone test. | Vite + Tailwind + shadcn + `motion` scaffold; three-panel layout; camera colours set | `AgentRelay.createWorkspace` → share the key; two registered agents exchange a thread reply (**test under Bun**) |
| **0:15–0:35** | `lib/capture.ts`: camera, motion gate, clock sync | Hand-write a small mock `DashEvent` file; map with nodes and drag-to-place | **Record fixtures** with phones' normal camera apps: calibration walk, incident, and a guest clip from a 4th phone. Note the start time of each. |
| **0:35–1:20** | `/api/ingest` → `vision.ts` → `CameraActor` + alarm; `SiteActor` (links, blind-spot alarm, knocks) + `EntityActor` | Link and blind-spot animations, Relay message cards, timeline, frame dialog, all against the mock | Witness agents (`recall` → testimony), investigator loop, `IncidentActor`, `logRelay` |
| **1:20–2:00** | **Integrate, end to end on fixtures:** links appear → incident → timeline with citations. B switches from the mock to live websockets. | | |
| **2:00–2:30** | Live phones; unplug test; `align.ts` for guest clips | `/capture` and `/witness` pages around A's `capture.ts`; revision animation; polish at projector resolution | Contradiction → re-examine; knock → Approve → `addWitness` → revised verdict |
| **2:30–3:00** | **Freeze.** Cache every LLM response from a fixture run and record its `DashEvent` stream into the mock file. Rehearse the demo 3 times on the real projector. Decide whether to go live or use fixtures. | | |

**Solo or two people?** Merge A and C, keep B on the front end, and cut from the top of the list below.

### Cut list (cut from the top when behind)

1. Re-examination with a second vision call → the investigator settles contradictions from the text alone
2. Follow-up chat box on the dashboard
3. Guest knock/approve → an "add witness" button plus file upload (the new camera still answers over Relay)
4. Event-matching alignment → set the guest clip's offset by hand from the fixture notes
5. Live phones → fixtures played through replay mode (the pipeline stays real; only the input is recorded)
6. Handoff DMs → links learned in `SiteActor` only
7. Learned layout → hand-drawn links on the map (**last resort**: it's the opening moment)

**Never cut:** one actor per camera with memory, questioning over Relay, the timeline with citations, the late witness revising the verdict, and the front-end polish.

---

## 11. Safe demo

Three levels, from most live to safest. Choose on stage.

1. **Live:** real phones, real staging. Only if it worked on the venue network during setup.
2. **Fixtures:** recorded clips played through the real pipeline, with LLM responses served from the cache. Runs offline in under 2 minutes.
3. **Recorded run:** the dashboard plays back the recorded `DashEvent` stream from the freeze. It looks identical and can't fail.

**Staging:** three phones on tripods or propped on cups; one actor in a **bright, distinctive** jacket; the bag a strong colour. Pick a blind spot on purpose (one exit with no camera) so it reliably lights up. For a guaranteed "black vs navy," put the jacket wearer in shadow from one camera.

---

## 12. How each judging criterion is covered

| Criterion | Our answer |
|---|---|
| Real-time AI + sponsor tech | Vision per frame on every camera, a live investigator loop, and the layout learned live. Each Terse actor uses memory, ordering, alarms and broadcasts; Relay carries questioning, handoffs and outside witnesses. |
| Originality | Cameras as witnesses being questioned, not a footage search. The cameras also learn the room's layout and find their own blind spots, and a clip that was never synced gets lined up by what it saw. |
| Execution + demo | Staged in front of the judges, using their room; three levels of fallback |
| UX + design | Join by QR code with nothing to install. One screen: map, agent conversation, timeline. Each camera keeps one colour throughout, and every claim links to a frame. |
| Potential + impact | Warehouse safety, insurance claims (dashcams + doorbells with owners' consent), venues, disaster drones. The learned layout makes every new site cheaper to set up. |

---

## 13. Check before building

- [ ] `@agent-relay/sdk` runs under Bun (it's documented for Node 22+). If it doesn't, run `server/relay.ts` as a separate Node process that calls the Bun server over HTTP.
- [ ] Does `addListener('message.created')` on one `relay` client receive messages for **every** agent registered through it, or do we need one client per agent?
- [ ] How fast does a thread reply arrive in a listener? We need well under 1s for the questioning to read as live.
- [ ] Terse: confirm calling an actor from the backend (`actors.X.get(id)`) and that `prepareWebsocket` works with broadcast `tags`
- [ ] Haiku vision latency at 3 cameras × 1 fps. If it's over about 1.5s, drop to 0.5 fps and lean on the motion gate.
- [ ] Camera access over the tunnel on iOS Safari and Android Chrome
- [ ] Stretch: the Relay Connect room for a neighbour's camera agent (set up by an agent session at agentrelay.com/connect)

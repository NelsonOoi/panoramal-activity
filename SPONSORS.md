# How Panoramal Activity Uses Terse and Agent Relay

**Panoramal Activity** treats every camera in a building as a witness. When something happens, an investigator agent questions the cameras, compares their accounts, cross-examines them when they disagree, and produces a timeline where every claim cites a camera and a timestamp.

The two sponsors split the work cleanly:

- **Terse** holds the *memory and the rules*: who saw what, in what order, and what happens when someone goes quiet.
- **Agent Relay** carries the *conversation*: the questions, the testimony, the cross-examination, and outsiders asking to join.

```
   phones ──frames──► server ──► CameraActor ×N  ─┐
                                 SiteActor        ├─ Terse (state, order, alarms, broadcasts)
                                 IncidentActor ×N ┘
                                      ▲
                                      │ recall() / addTestimony()
   witness agents ◄──── #incident-N ────► investigator     Agent Relay
   guest phone ──knock──► @site ──admit──► #incident-N
```

---

## Terse: durable actors

We use four kinds of actor. Each one is a small server with its own database that handles one request at a time. **We use every core Terse feature: persisted state, serialized requests, alarms and broadcasts.** Each one does a job that would otherwise take a queue, a cron job, a lock or a pub/sub service.

### `CameraActor`: one per camera, the witness
[`src/actors/camera.ts`](src/actors/camera.ts)

- **Persisted memory.** Every observation from that camera (people, objects, actions, a frame reference) goes into the actor's own log. When the investigator asks a camera a question, the camera answers *from its own memory* (`recall(t0, t1)`), not from a shared database.
- **One request at a time.** Frames from one phone are ingested strictly in order, so "entered, then left" can never be reversed by two frames racing.
- **Alarm as heartbeat.** Each frame re-arms a 5-second alarm. If a phone is unplugged or locked, the alarm fires, the dashboard marks it "Offline · memory kept", and its memory stays intact for later questioning.

### `SiteActor`: one per building, the directory and learned handoffs
[`src/actors/site.ts`](src/actors/site.ts)

- **Learns how cameras connect.** When a person walks off the edge of one camera's frame and appears in another within 20 seconds, the site records a **handoff** between those two cameras with the average walking time (for example, cam-1 → cam-2 in 3.6s). Nobody configures it; it comes from people walking through. It's persisted, so a site that has run for a week knows its own handoffs.
- **Alarm as blind-spot detector.** A person counts as exited after 2 missed frames at an edge of the frame. Exits that never match an entry within 20 seconds count against that edge. After 3, the edge is flagged as a **blind spot**: people leave there and are never seen again. The alarm is the detector: no polling, no cron.
- **Serialization prevents double counting.** One exit can't be matched to two entries. Two "Investigate" clicks for the same event return the same incident (`openIncident` deduplicates overlapping time windows). An Approve button clicked twice is still one decision.
- **Alerts that escalate themselves.** Big changes raise an alert: an object gone or left behind, a crowd arriving, a camera covered or moved, or anything notable. There's at most one per camera every 10 seconds. Each alert arms a **30-second Terse alarm**. If nobody acknowledges it, the alarm fires, the actor **opens an incident by itself** and posts the escalation over Relay ("Escalated: no response in 30s. Investigation started."). Nobody watching the screen is no longer a failure mode. (Measured: the alarm fires 0.06s after its deadline.)
- **Broadcasts drive the dashboard.** The dashboard opens one websocket to `SiteActor` and receives every live update (cameras, handoffs, blind spots, alerts, knocks, Relay messages, timeline revisions) as a Terse broadcast ([`src/publish.ts`](src/publish.ts)). No separate pub/sub service.

### `IncidentActor`: one per case, the case file
[`src/actors/incident.ts`](src/actors/incident.ts)

- **A case that can't be dropped.** The incident persists its question, time window, every witness's testimony, the timeline, the open contradictions, and a full transcript of every Relay message in the case.
- **Alarm as testimony deadline.** Opening a case asks every camera and arms a 10-second alarm. Witnesses who haven't answered by then are marked *silent* and the investigator proceeds without them, so one dead camera can't stall the case.
- **Revisions, not rebuilds.** When new evidence arrives minutes later (a guest's clip), `addWitness()` reopens the case. The new timeline is stored as a **revision**, with the previous one kept. The dashboard shows exactly which claims changed and strikes through the old ones. Each person's storyboard marks where nobody saw them ("unseen 5.2s", or "not seen again"); when the guest's clip covers that stretch, the new sighting is added and the verdict moves to the next revision.
- **Concurrent testimony, nothing lost.** Witnesses answer at the same moment; serialized `addTestimony()` calls mean every answer is recorded once.

**Design rule:** no LLM call ever runs inside an actor method. A 2-second model call would block that actor's queue. The server and the Relay bridge do the thinking, and the actors keep the record.

---

## Agent Relay: agents talking to agents

Every camera, the investigator and the site itself is a **registered Relay agent**. The investigation is literally a conversation between them, and the dashboard's middle panel shows that conversation as it happens.

### Investigator questioning in channels and threads

- Each incident gets its own channel, **`#incident-N`**. The investigator (an LLM agent, currently `gpt-5.5`) posts one structured `question` per line of enquiry.
- Each camera's witness agent replies **in that question's thread** with structured `testimony`: timestamped claims, people involved, a frame reference and a confidence. A thread is the complete record of one question and its answers, and the final report cites it.
- Witness agents (currently `gpt-5.4-mini`) answer only from their own camera's memory. The investigator never sees raw footage, only testimony. This is what keeps it a *questioning*, not a footage search.

### Ask any camera directly, even an offline one

Clicking a camera on the dashboard opens **Ask this camera**. The operator's question goes to that camera's agent as a Relay direct message (operator → `@cam-x`), and the camera answers from its `CameraActor` memory (its last 10 minutes) in about 2 seconds. Because the memory lives in the actor and not on the phone, **this works after the phone is unplugged**. Relay gives every camera an address; Terse makes sure there's still someone home.

### Cross-examination by direct message

When two witnesses disagree ("black jacket" vs "navy jacket"), the investigator **DMs each camera** a `reexamine` request about that moment. Each camera re-reads its own record of it and answers, privately, outside the shared channel. The contradiction is settled on the record, with both sides cited.

### Late witnesses: knock and admit

This is Relay's access model doing real work:

1. Someone in the room scans a "Saw something?" QR code and uploads a clip from their own phone.
2. Their phone becomes a `guest-…` agent that is **not** on our team. It sends a `knock` to `@site`.
3. The operator sees a toast and chooses **Approve** or **Deny**. Only an approved guest is added to `#incident-N` and questioned like any other camera.
4. The clip was never synced to anything. We line it up by matching an event both it and a site camera saw (for example, "bag picked up"), and the case is revised: the gap where nobody saw the person is filled.

Outsiders can't read the case or talk to our cameras unless the owner lets them in.

### Where this goes: cooperation without sharing records

The same pattern extends across owners with **Relay Connect**. A neighbouring business's camera agent joins a temporary room for one incident and answers questions about its own footage, and that footage never leaves its owner. This is the pitch for insurance claims (dashcams plus doorbells) and multi-tenant buildings. It's a stretch goal for the demo, not a core path.

### An honest note on latency

Relay's hosted service was slow during the hackathon. We measured sends being acknowledged in 6–23 seconds (median 9) and delivery to listeners in 10–40 seconds, with many `503`/`429` retries, but **no failed sends**. Every message still goes through Relay, which is the shared record and the only way in for outside agents. Agents running in the same process get each message straight away instead of waiting for the network round trip (`RELAY_LOCAL_DELIVERY=1`, the default).

We tested the pure-Relay path too (`RELAY_LOCAL_DELIVERY=0`). Delivery works end to end, but at today's latency testimony misses the 10-second deadline, so the witnesses are marked silent. That's the deadline alarm doing its job, which is why the demo runs with local delivery. We don't claim millisecond messaging. What Relay gives us is identity, access control, threads and cross-owner rooms.

---

## What each sponsor feature replaces

| Without the sponsor we'd need… | We use instead |
|---|---|
| A database plus a per-camera queue to keep frames in order | `CameraActor` persisted log, serialized `ingest()` |
| Cron jobs to detect dead cameras, blind spots and missed deadlines | Terse **alarms** (heartbeat, blind-spot, testimony deadline) |
| Distributed locks to stop double-assignment and duplicate incidents | Terse **one-request-at-a-time** actors |
| A pub/sub service and websocket server for the dashboard | Terse **broadcasts** from `SiteActor` |
| A homemade message bus, plus auth for outside phones | Relay **channels, threads and DMs**, plus the **knock/admit** access model |
| Shared database access between organizations | Relay Connect rooms (stretch) |

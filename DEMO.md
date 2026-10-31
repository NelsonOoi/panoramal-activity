# Panoramal Activity: 2-Minute Demo Script and Staging

> Written for the rebuilt camera-wall dashboard. The quoted UI text is confirmed against the build. Alert *messages* (like "Yellow tote is gone from the table") are examples: the real wording depends on what the cameras see.

Read this once fully, then use only **Beats** and **Pre-demo checklist** on stage.

## Roles (3 people)

| Role | Who | Does |
|---|---|---|
| **Presenter** | | Talks, drives `/dash` on the laptop (projector). Only person speaking. |
| **Walker** | | Does the calibration walk *and* plays the thief. Wears the jacket. Silent. |
| **Plant** | | Sits in the front row with a phone. Is the "audience member" who adds footage. Has the backup clip already in their camera roll. |

Solo fallback: Presenter is also the Walker; skip the Plant and use the dashboard's add-witness upload with the backup clip.

## What's on the dashboard

- **Look:** restrained shadcn dark: greyscale throughout, with no colour per camera. Red appears only on alerts.
- **Header:** "3 of 3 cameras live", **New incident**, **What just happened?**
- **Cameras** card ("Most active first. Select a camera to see its latest analysis."): a 2×2 grid of 4 tiles per page, with ‹ › buttons and "1–4 of N". Tiles sort most active first (alert → people in view → live → guest → offline), so **they re-sort as things happen. Find a camera by its name, not its position.** Each tile shows the latest frame, who's in view (A, B… with descriptions) a badge (**Live**, **Guest clip** or **Offline · memory kept**, plus a red **Alert** tag), "N obs", "Nobody in view" when empty, and "Last frame HH:MM:SS".
- **Below the grid:** **Learned handoffs** (rows like "cam-1 → cam-3 · 3.2s avg · 2 seen", built from people walking between cameras), the **Add camera / Scan with a phone** QR, and the **Saw something? / Add your footage** QR for the Plant.
- **Camera view** (click a tile): the latest frame large, with boxes and labels; **In view now**; **Objects**; a **Recent log** (newest first, where unchanged stretches collapse to one line: "A · picking up bag · 14:22:43–14:23:43 · 19 frames"); and **Ask this camera** with an **Ask** button. It answers from its own memory in about 2s, **even when it's offline**. It only remembers the last 10 minutes. If it fails, you'll see "Camera couldn't answer" with **Retry**.
- **What just happened?** is one click and covers the last 60s. **New incident** opens a dialog with a question, **Last 1 min / Last 5 min / Last 15 min / Custom**, and cameras (all checked), with **Cancel** and **Start investigation**. It always starts a fresh case.
- **Alerts** (toasts, bottom-left) for big changes, each with a type badge: **Object gone** ("Yellow tote is gone from the table"), **Object left** ("Backpack left unattended"), **Crowd change** ("4 people arrived"), **Camera tampered** ("Camera covered or blurred": the lens dark or flat for 3s) or **Notable** (the model's own remark, e.g. "picks up the yellow tote"). **Only Object gone, Object left and Camera tampered escalate:** they count down **"Auto-investigates in 30s"**, then show **"Escalating…"**. **Crowd change** and **Notable** are **"Notification only"**: no countdown, and dismissing them acknowledges them. All alerts have **Acknowledge** and **Investigate** buttons. Each camera raises at most one alert per 20s (an escalating alert can still follow a notification-only one), and **a newly connected camera raises no alerts for its first 60s**. Afterwards it reads **"Acknowledged · escalation cancelled"**, **"Investigating · inc-N"**, or, **if nobody responded in 30s and the alert's Terse alarm fired by itself**, **"Escalated: no response in 30s. Investigation started."**
- **Knock toast:** "guest-xxxx wants to add footage" with **Deny** / **Approve**, then "… was approved · clip added to the case".
- **Relay** card ("Messages between agents", footer "via Agent Relay"): questions, threaded testimony, cross-examination.
- **Case file:** a status badge (**Gathering** → **Analysing** → **Complete**), "Searching memory…" while witnesses answer, the timeline with citation chips and **Revised** items, **Contradiction resolved**, and a **Verdict** panel with "Revision N". There's also a **storyboard per person**: thumbnails cam → cam, a dashed **"unseen 5.2s"** connector for a gap *between* two sightings, and a final **"not seen again"** when nobody saw them afterwards.
- **Blind spots** take 3 unmatched exits, so they **aren't a live beat**. The storyboard's "not seen again" tells that story instead.

## Room layout

```
                 BACK WALL
   ┌───────────────────────────────────────┐
   │                                       │
   │   [cam-3]                   [cam-2]   │
   │    ↘ facing table      facing table ↙  │
   │                                       │
   │              ┌───────┐                │
   │              │ TABLE │ ← bag          │
   │              └───────┘                │
   │                                       │
   │   [cam-1]                             │
   │    → facing entrance                  │
   │                                       │
   ├── ENTRANCE (in) ─────── BLIND EXIT ───┤  ← no camera sees this exit
   └───────────────────────────────────────┘
          AUDIENCE / JUDGES        Plant sits here, near the blind exit
```

- **Point every camera at a wall or a quiet area, never at the crowd.** In the hall test, background people produced 88 tracked people. Each frame is now capped at the 6 most prominent people, but a busy background still steals those slots.
- **cam-1** sees the **entrance** only, aimed *across* it at a wall, not out at the audience. It's the "who came in" camera.
- **cam-2** and **cam-3** both see the **table**, from opposite sides, each with a wall behind it. That overlap is what makes the contradiction and the cross-examination possible.
- **Blind exit:** one route out that no camera covers (a side door, or behind a screen or curtain). Every other way out must be on camera. This is where the thief's storyboard ends in **"not seen again"**.
- **Plant's seat:** the Plant's phone has a clear view of the blind exit. Their clip is what adds the missing step.
- Phones at chest height on tripods or propped on cups, in landscape, plugged into power. Each one is about 2–3 m from what it watches. Person-sized in frame works best. Setup is just: scan, prop up, done. Nothing to place on screen.

## Outfit and props

- **Walker:** a **dark navy jacket** in a solid colour, plus one more distinctive item (a bright beanie, **not** a backpack: a backpack counts as a valuable to the alert system) so re-identification is easy.
- **Contradiction setup:** put the table between cam-2 and a light source. In cam-3, which is backlit or in shadow, the navy jacket should read as **black**. Check this by clicking cam-2's and cam-3's tiles: the camera view shows each one's description of the Walker. Or type "What colour is the jacket?" into **Ask this camera**. If both cameras agree, move cam-3 into the shadow or dim the light on its side.
- **Bag:** an obvious, ordinary **bag** in a strong single colour (yellow or orange), on the table, clearly visible to cam-2 *and* cam-3. Bag, tote, backpack, purse and handbag are now all treated as the same word when the guest clip is matched, so the label doesn't matter. What matters is that the **pickup is clearly visible** to the table cameras *and* in the guest's clip (alignment found the offset to ±1s in testing). It must be a **valuable**: only a bag, tote, backpack, purse, suitcase, laptop, box/package or helmet can trigger Object gone or Object left. Never use a phone, bottle, cup or keyboard. **Keep every other valuable out of the cameras' view**, including the presenting laptop and people's bags on nearby seats, or moving one will raise its own alert.
- **Nobody else** in a navy or black jacket walks through the cameras during the demo. Ask the front row.

## Timings the system needs

These come from the actor alarms. Rehearse to them.

| Thing | Rule | What it means on stage |
|---|---|---|
| Camera offline | 5s with no frame | Phone screens must stay on. Wake Lock should handle it; plug them in anyway. |
| Exit detected | Gone for 2 frames, **off an edge of the frame** | Walk fully out past the side of the frame. Fading out mid-frame (walking away from the camera) doesn't count as an exit. |
| Handoff learned | Exit one camera, appear in the next within 20s | The Walker must walk *out of* one view and *into* the next, not stand in two at once. |
| Blind spot | 3 unmatched exits on one edge | Not used live. Don't wait for it. |
| Testimony deadline | 10s | A silent camera won't stall the investigation. |
| Manual window | The last 60s | If you use the button or `i`, press it within 60s of the grab. |
| Alert warm-up | No alerts from a camera for its first **60s** after it connects | Phones must be connected **at least 2 minutes before** going on stage. Re-plugging a phone restarts its warm-up. |
| Alert cap | One alert per camera per 20s | Pick the bag up in **one clear motion**, facing cam-2/cam-3. |
| **Object gone** | The bag absent for 3 frames, plus vision time: **about 3.5s after the Walker carries it out of the frame** (measured at 2.5s in simulation, plus about 1s of real-phone vision time) | The countdown starts when the bag is **out of cam-2's and cam-3's view**, not when it's picked up. While the Walker is in frame holding it, or standing where it was, it counts as hidden, not gone. **Grab and go.** |
| Alert escalation | 30s with no Acknowledge/Investigate | Only **Object gone**, **Object left** and **Camera tampered** escalate. If one of those appears by accident (someone moves a bag, or a hand covers a lens), **Acknowledge** it at once. Crowd change and Notable are notification-only and harmless. |
| Incident window (alert) | 30s before to 15s after the alert | The whole theft (walk in → grab → out the blind exit) must fit in about 30s. |

### Measured investigation timings (from integration)

The beats below are built around these. Rehearse with a stopwatch.

| From | Event | Arrives after |
|---|---|---|
| Click **Investigate** | Question card | Instantly |
| | Testimony cards | About 2.5s |
| | Timeline and contradiction card | About 13s |
| | Cross-examination cards | About 14s |
| | **Verdict** | **About 22s** |
| Plant taps upload | Knock toast (10–12s clip) | About 20s |
| Click **Approve** on the knock | **Revised verdict** | **About 15s** |

Only **one** contradiction is cross-examined per run, so stage exactly one (the jacket colour).

**Relay is slow today:** sends take 6–23s to be acknowledged and 10–40s to reach listeners, with many retries (but no lost messages). The dashboard doesn't wait for that, so it stays fast. **Don't open Relay's own web UI on stage**: it trails the dashboard by 10–40s and will look broken. **Never say "real time" or "milliseconds" about Relay.** Say "the cameras are being questioned".

## Beats

The left column is time from "go". **Bold lines are said out loud.**

### 0:00 Cameras already live

Don't scan QR codes live: it eats 15s and phones misbehave. Start with three tiles live and the header reading "3 of 3 cameras live".

> **"Every camera here is a witness. It has its own memory and remembers everything it saw. When something happens, an investigator agent questions them like a detective would."**

### 0:10 Calibration walk (about 20s)

The Walker's route: **in the entrance (cam-1) → off the side of cam-1's frame → into cam-2 → off the side of cam-2's frame → into cam-3 → out**. Walk briskly and leave each frame past its edge.

> **"Nobody told it how these cameras connect. It's learning as our teammate walks: every time someone leaves one camera and turns up in another, it learns that handoff and how long the walk takes."**

Point at **Learned handoffs** below the grid as a row like "cam-1 → cam-2 · 3.6s avg · 1 seen" appears.

### 0:30 The incident (about 15s)

The Walker comes in through the entrance, walks to the table, **picks the bag up in one clear motion** (around 0:36), and **goes straight away**: out of cam-2's and cam-3's frames within 3–4s (by about 0:40), then **through the blind exit**. The Presenter says nothing until the Walker is out of the table cameras' view, then fills the 3–4s while the system notices:

> **"…and the bag's gone. Nobody's pressed anything. Let's see if the cameras noticed."**

**Plant:** start recording on your phone's normal camera app **just before the Walker reaches the table** (around 0:33), from your seat by the blind exit. Get the bag grab *and* the exit in the shot, and stop by about 0:45. **Keep the clip to 10–12s**: each second of clip adds about 1.3s of processing before the knock appears.

### 0:45 It triggers itself

Bottom-left, a **Notable** toast ("picks up the yellow tote", marked **"Notification only"**) may appear first. **Don't click it.** About 3.5s after the Walker leaves the frame, the **Object gone** alert appears: **"Yellow tote is gone from the table (last held by A)"** (it'll say whatever the cameras call the bag), counting down from **"Auto-investigates in 30s"**.

> **"We didn't press anything. The cameras noticed the bag is gone. And if nobody here reacts within 30 seconds, it doesn't wait: it opens the case itself and escalates."**

**Click Investigate on the Object gone toast**, the one with the countdown. (If you click the Notable one by mistake, that's fine: both join the **same** case, and the other switches to **"Investigating · inc-N"**.)

Click **Investigate** by **0:46**. Don't let it escalate on stage: that costs 30s the script doesn't have. The clock starts here: the verdict lands about 22s later.

**If no alert within 6s of the bag leaving the table cameras' view:** click **What just happened?** (not sooner: "not seen again" only appears when the thief's last sighting is more than 5s before the case's time window ends) in the header (or press `i`), type "Who took the bag?", and say *"Let's ask what just happened."* Don't mention the missing alert. (Use the one-click button on stage, not **New incident**: its dialog takes too long to fill in live.)

**Plant, silent cue:** the moment Investigate is clicked, stop recording, tap **Upload a clip** on the `/witness` page (already open, see the checklist) and pick the clip. The phone then shows "Asking the site to accept your footage…". Don't wait to be asked. Processing takes about 20s, so the knock lands around 1:05–1:10. Upload **straight after recording**: on iPhone, the file's time is set when it's picked, and an immediate upload keeps the fallback clock alignment within a few seconds.

### 0:46 Questioning (about 13s to fill)

The case file shows **Gathering** and "Searching memory…". In the **Relay** card, the question appears instantly and the testimony follows about 2.5s later as threaded replies.

> **"The investigator posts one question to the incident channel. Each camera answers from its own memory, and only about what it saw. The investigator never sees the raw footage, just the testimony."**

Then point at the camera wall while the timeline is being built: *"cam-1 saw someone come in. cam-2 and cam-3 both saw the table…"*

### 0:58 Contradiction (about 10s)

The case file moves to **Analysing**. The timeline and the contradiction (cam-2 "navy" vs cam-3 "black") land together, and the cross-examination messages follow a second later:

> **"Two witnesses disagree: navy or black? Just like a detective, it goes back to each of them privately and asks them to check their own record of that moment."**

If the knock toast pops up during this, **leave it**. You'll come back to it.

### 1:07 Verdict and the gap

The badge turns **Complete**, the contradiction shows **Contradiction resolved**, and the **Verdict** panel fills.

> **"Navy. cam-3 was in shadow. And it tells you why, citing the frames."** (Read out whatever verdict it actually gives.)

Point at the thief's **storyboard**: … → the table camera (e.g. cam-2, with its frame and time) → a dashed **"unseen"** connector → an empty dashed frame, **"not seen again"**.

> **"The table camera is the last to see them, then: not seen again. That exit has no camera, and the case file says exactly that instead of guessing."**

### 1:12 Late witness (the big moment)

Point at the knock toast, **"guest-xxxx wants to add footage"**:

> **"While we were watching, someone in the audience sent in what they filmed. Their phone isn't one of our cameras, so it has to knock, and we decide whether it gets in."**

The Plant raises a hand. Click **Approve** by **1:15**. The toast reads "… was approved · clip added to the case", and the Plant's phone says "Thank you". The revision takes about 15s, so fill it:

> **"That clip was never synced to anything. The system is lining it up by matching an event both phones saw: the bag being picked up. Then it questions the new witness just like the others."**

(So the Plant's clip **must show the bag grab**, not just the exit, or alignment has nothing to match.)

Around 1:30 the storyboard changes: cam-2 → a solid connector with the transit time (e.g. **"4.4s"**) → a new **guest-xxxx** step with its own frame and time → dashed "unseen" → **"not seen again"**, which has moved to the end. (If the gap is long, the connector stays dashed as "unseen 12s" or similar. That's fine; point at the new step.) The timeline shows **Revised** items, and the Verdict reads **Revision 2**.

> **"The guest's clip adds the next step: they left through the side exit, then they're gone. And the case wasn't rebuilt. It was revised, and you can see exactly what changed."**

An Approve clicked while the investigation is still running is safe: it waits for that run to finish, then revises.

**Walker, silent cue (only if we're on time):** once the Plant's knock is approved (about 1:15), quietly unplug or lock **cam-1**, the entrance camera, which isn't needed any more. Within 5s its badge reads **Offline · memory kept**, and it drops to the end of the grid. It's set up for the 1:40 beat.

**If there's no knock toast by 1:15:** keep talking about the gap for a few seconds (*"Did anyone here see where they went?"*). If the toast still isn't there by 1:25, skip the approval and go to the report: *"the verdict revises when that clip lands."*

### 1:35 Report

Click one citation chip so the frame opens with the bounding box.

> **"Every sentence links to a camera and a timestamp."**

### 1:40 Optional: ask a camera that's offline (only if cam-1 is already offline by 1:40)

Find cam-1's tile, now **last** in the grid and badged **Offline · memory kept**, and click it. In **Ask this camera**, type **"Who came in through the entrance?"** (it's also the placeholder text) and click **Ask**.

> **"That camera is unplugged. But it's an actor with its own memory, so we can still question it."**

The answer appears in about 2s. Read it out. If it shows "Camera couldn't answer", click **Retry** once. (It only remembers the last 10 minutes. The Walker came in a minute or two ago, so that's fine, but don't ask it about earlier rehearsals.) If nothing arrives by 1:50, move on: *"…and it'll answer from memory even now."*

### 1:50 Close

> **"Each camera is a Terse actor that never forgets; the witnesses, the investigator and outside phones all talk over Agent Relay. Think warehouses, insurance claims, venues: every site that runs it learns its own handoffs."**

Stop at 2:00 even if something is still animating.

## Fallback ladder

Decide at the setup check, not mid-demo.

1. **Live:** only if the full run worked on the venue network during setup.
2. **Fixtures:** the recorded clips go through the real pipeline with cached LLM responses. Same script, but the Walker doesn't walk; the Presenter says *"here's the same walk we recorded earlier."*
3. **Recorded run:** open `/dash?replay=/recordings/<file>.jsonl`. It looks identical and can't fail. Use it if Relay is returning 503 errors at showtime.
4. **Last resort:** `/dash?mock=1` plays a scripted version of the whole story in about 80s (`&speed=2` halves that). Use it only if there's no good recording. It's shorter than the live script, so slow your narration down rather than padding.

**Making the recording:** the dashboard records every event. After the best rehearsal run, press `d` to open the dev panel, download the JSONL, and save it under `recordings/`. Do this during the freeze, and again after any rehearsal that goes better.

Mid-demo, if a live step hangs for more than 15s, say *"let me show you the run from this morning"* and switch to level 3 at the same beat. Keep the replay URL open in a second tab so the switch takes one click.

## Pre-demo checklist

**30 minutes before**
- [ ] Laptop and all phones on **our hotspot**, not the venue Wi-Fi
- [ ] `/dash` open in **Chrome or Firefox**, not Safari (the laptop's Safari on macOS 12 is too old)
- [ ] `cloudflared` tunnel running; `PUBLIC_URL` matches; the QR codes on `/dash` open on a phone
- [ ] Model API keys (OpenAI) and `RELAY_WORKSPACE_KEY` set; send one Relay test message and note how long it takes
- [ ] **Full wipe:** `POST /api/site/wipe` clears everything, including cameras, so numbering restarts at cam-1. Phones then show "Unknown camera": tap **Reload** on every phone (they need to after any wipe *or redeploy*, to pick up the latest capture code) and rejoin them in order ("Tap to start witnessing"): cam-1 at the entrance, cam-2 and cam-3 at the table. Each phone's pill should read "Witnessing as cam-N · … · synced ±N ms".
- [ ] Every camera points at a wall or a quiet area. Each tile shows only our people, not the crowd.
- [ ] Phones plugged in, Auto-Lock off, brightness down, Do Not Disturb on
- [ ] Each tile checked on the camera wall: the table is visible to cam-2 and cam-3, and the entrance is visible to cam-1
- [ ] Shadow check: cam-3's tile describes the jacket as black
- [ ] Full dry run: handoffs appear, the **Object gone** alert fires when the bag leaves the table, testimony arrives, the storyboard ends cam-2 → "unseen" → "not seen again", then shows the guest step (with a frame) before "not seen again" after Approve
- [ ] The Plant's phone has the **backup clip** in its camera roll and has tested the `/witness` upload once
- [ ] Best rehearsal saved as a recording (`d` → download → `recordings/`); `/dash?replay=…` plays it, open in a second tab
- [ ] Rehearse the 1:40 beat once: unplug cam-1, then **Ask this camera** "Who came in through the entrance?", and time the answer. Measured at about 2s; if it takes more than 8s on the day, cut the beat.

**Between rehearsals**
- [ ] **Shift+R** on `/dash` (soft reset): cameras stay; handoffs, blind spots, people, alerts, knocks and incidents clear. No phone reload needed.
- [ ] Plug cam-1 back in if you unplugged it, and check its tile is live again. Its 60s alert warm-up restarts, which doesn't matter for cam-1, the entrance camera, since the bag alerts come from cam-2 and cam-3.
- [ ] To test a quick follow-up without resetting, use **New incident**: it always opens a fresh case.

**2 minutes before**
- [ ] **Shift+R** once more. Confirm there's no old toast, no old case file and no stale handoffs.
- [ ] Bag back on the table, facing the cameras
- [ ] The Plant's phone has `/witness` **already open** (scanned during setup), the camera app ready to record, and the screen unlocked
- [ ] Relay's own web UI is closed on the presenting laptop
- [ ] No alert toasts showing. During the demo, **Acknowledge any stray countdown alert immediately** (Object gone, Object left or Camera tampered), or it opens a case by itself in 30s. Notification-only toasts can be ignored.
- [ ] All phones connected **at least 2 minutes ago** (60s alert warm-up). Don't re-plug or reload a phone after this point.
- [ ] `/dash` full-screen on the projector at projector resolution; the browser zoom makes the cards readable from the back
- [ ] Walker at the entrance, out of every camera's view, and knows where cam-1's cable is for the 1:15 unplug cue
- [ ] Header reads "3 of 3 cameras live" (cam-1 plugged back in after the last rehearsal)
- [ ] Nobody in a navy or black jacket in front of the cameras

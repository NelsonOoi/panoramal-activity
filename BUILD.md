# Panoramal Activity: Build Brief (read fully before writing code)

Every camera is a witness. An investigator agent questions them over Agent Relay and builds a cited timeline. Terse durable actors hold each camera's memory, the site's learned layout and each incident's case file. The full product plan is in `PLAN.md`, the stage script in `DEMO.md`. **This file wins wherever they disagree.** Where this file is silent, choose the simplest thing.

## Environment

```bash
export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v22.16.0/bin:/opt/homebrew/bin:$PATH"
```

- One Bun project. The root is this folder. Dependencies are already installed: express, vite, react, tailwind v4 (`@tailwindcss/vite`), motion, lucide-react, qrcode.react, @anthropic-ai/sdk, @agent-relay/sdk, zod. Add a package only if you really need it, with `bun add`.
- `.env` holds `RELAY_WORKSPACE_KEY` (a Relay workspace already exists), `DURABLE_ACTORS_CONTROL_PLANE_URL`, and **`OPENAI_API_KEY` once the user adds it**. It may not be there yet: LLM code must fail with a clear log line, never crash the server. Bun loads `.env` automatically.
- **The Terse runtime is already running** (`bunx durable-actors dev`, port 7100, log in `.logs/actors.log`). It hot-reloads actor source. **Don't start another one or kill it.** After you change an actor's method names or signatures, run `bun run gen` to regenerate `generated/` (the typed client).
- **LLM: OpenAI, only through `src/llm.ts`** (lead-owned). Call `llmJson<T>({ tier: "fast" | "smart", system, prompt, image?, maxTokens? })`, which returns parsed JSON or `null`. Use `fast` for vision on every frame and witness testimony, `smart` for the investigator. It already caches on disk by request hash (`.cache/llm/`) and returns `null` with one log line when `OPENAI_API_KEY` is missing. **Don't import `@anthropic-ai/sdk` or the OpenAI SDK.** The prompt must say "JSON" and describe the exact shape; validate the shape yourself and fall back on `null`.
- Don't commit or push; the lead handles git.

## Verified facts (don't re-research)

- **Terse:** `class X extends Actor<Metadata, Incoming, Outgoing>`. Application methods must be `async`. Instance fields need `@Persisted` (JSON values only: plain objects and arrays, no `Map`/`Set`) or `@Ephemeral`. Each actor has one alarm: `this.alarm.set(Date.now() + ms)` and `async onAlarm()`; the alarm clears after it fires unless you set it again. `this.broadcast(msg)` sends to this actor's sockets. Calls run **one at a time per actor instance**. Backend code calls `actors.X.get(id).method(...)` from `generated/index.js`. Inside an actor, `OtherActor.get(id).method()` (static, imported class) is documented as returning a backend reference. It's untested here: try it, and if it fails, move the call to the server.
- **Dashboard socket:** `actors.SiteActor.prepareWebsocket({ actorId: "site", metadata: { role: "dashboard" } })` returns `{ websocketUrl }`. The browser opens `new WebSocket(websocketUrl)`. `SiteActor.onConnect` sends a `snapshot`. **Any code sends dashboard events with `publish(event)` from `src/publish.ts`.** Tested end to end, about 0.5s.
- **Relay** (`@agent-relay/sdk` v15, works under Bun): `new AgentRelay({ workspaceKey })`; `relay.workspace.register({ name, type: 'agent' })` returns a live client. **Registering is create-only: a name that already exists throws `name_conflict`.** Save each agent's token (`client.token` or whatever the client exposes; inspect it) in `.relay-tokens.json` and use `relay.workspace.reconnect({ apiToken })` on restart. Client methods: `channels.create({ name, topic })`, `channels.join(name)`, `sendMessage({ to: '#chan' | '@name', text })`, `reply({ messageId, text })`. One `relay.addListener('*', ev => …)` sees events for every agent registered through that client. Event types seen: `message.created`, `thread.reply`, `dm.received`, with `ev.message.text`, `ev.message.messageId` and `ev.envelope.from.handle` / `ev.envelope.channel.name`.
- **Relay is slow today:** sends take 2–20s, delivery about 2.5s, and it occasionally returns 503 `database_overloaded` (retryable). Design around it (track C below).

## Contracts

- **`src/shared/types.ts`** holds every shape, `DashEvent` and the HTTP route list. Build against it exactly. Changing it requires telling the lead in your final report.
- **Actor stubs** in `src/actors/{camera,site,incident}.ts` give the method signatures, and `src/actors.ts` re-exports them. Implement the bodies. You may add methods; don't rename or remove existing ones without regenerating and reporting it.
- **`src/relay.ts`** exports the functions the server calls: `startRelay`, `ensureCameraAgent`, `postAlert`, `runInvestigation`, `sendKnock`, `admitWitness`. It must stay importable at all times.
- **`src/web/lib/capture.ts`** (track A) exports the following, and track B builds the phone pages on it:
  ```ts
  export async function syncClock(): Promise<{ offsetMs: number; errMs: number }>   // 5× GET /api/time, keep fastest round trip
  export async function registerCamera(): Promise<CameraMeta>                       // POST /api/cameras (remember id in localStorage; reuse if present)
  export function startCapture(opts: { video: HTMLVideoElement; camId: string; offsetMs: number;
      onFrame?: (info: { sent: boolean; t: number }) => void; onError?: (e: Error) => void }): () => void  // returns stop()
  export async function extractFrames(file: File, opts: { fps: number; onFrame: (jpeg: Blob, clipMs: number) => Promise<void>;
      onProgress?: (p: number) => void }): Promise<{ durationMs: number }>
  export async function keepAwake(): Promise<() => void>                              // Wake Lock, re-acquired on visibilitychange
  ```
  `startCapture` uses the rear camera, runs at 1 fps, sends a 640px-wide JPEG (quality 0.6), and uses the motion gate: it compares a 32×24 grey thumbnail with the last one sent and sends when the change is large enough, or at least every 3s as a heartbeat.

## Numbers (other docs quote these; report any change)

Camera heartbeat alarm: **5s** without a frame → offline. Exit = entity missing **2** consecutive frames. Blind spot: **3** unmatched exits on the same edge (center exits never count; ambiguous crowd exits never count), checked after **20s** (the SiteActor alarm). Exit→entry match window: **20s**. Alert debounce: **1 per camera per 10s**. Testimony deadline: **10s** (IncidentActor alarm). Manual incident window: `[now-60s, now]`. Alert incident window: `[t-30s, t+15s]`. `openIncident` returns the existing open incident if the windows overlap.

## Ownership (touch only your files)

| Track | Files |
|---|---|
| **A: server + cameras + site** | `src/server.ts`, `src/vision.ts`, `src/align.ts`, `src/actors/camera.ts`, `src/actors/site.ts`, `src/web/lib/capture.ts` |
| **B: front end** | `index.html`, `vite.config.ts`, `public/**`, `src/web/**` except `src/web/lib/capture.ts` |
| **C: Relay + investigator** | `src/relay.ts`, `src/investigator.ts`, `src/actors/incident.ts` |
| lead | `src/shared/types.ts`, `src/actors.ts`, `src/publish.ts`, `package.json`, docs |

Scratch and test scripts go in `scripts/<track>-*.ts`. Need a change in someone else's file? Put it in your final report; don't edit it.

## Processes

- **Track A runs the app server:** `bun run dev > .logs/server.log 2>&1` (port 3000, `--watch`). Express with Vite in middleware mode (`appType: 'spa'`) serves the front end with hot reload on the same port; follow the Terse chat template pattern. Others read `.logs/server.log` and hit `http://127.0.0.1:3000`. They don't start their own.
- Track B develops in mock mode with `bunx vite --port 5173`, with a proxy for `/api` and `/frames` to `:3000`. That works without the back end.
- The Cloudflare tunnel is started by the lead at the end. The server reads `PUBLIC_URL` from the environment, defaulting to `http://127.0.0.1:3000`.

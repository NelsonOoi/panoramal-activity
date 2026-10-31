// Track C evidence (a): startRelay + ensureCameraAgent are idempotent across runs (reconnect via saved tokens).
// Run twice: RELAY_AGENT_PREFIX=ct- RELAY_TOKENS_FILE=.relay-tokens.test.json bun scripts/c-agents.ts
import { readFileSync } from "node:fs"
import { ensureCameraAgent, startRelay } from "../src/relay.ts"

const t0 = Date.now()
await startRelay()
console.log("startRelay", Date.now() - t0, "ms")
await startRelay() // second call is a no-op
const t1 = Date.now()
await Promise.all(["cam-1", "cam-2", "cam-3"].map(ensureCameraAgent))
await ensureCameraAgent("cam-1") // idempotent
console.log("ensureCameraAgent x3", Date.now() - t1, "ms")
const store = JSON.parse(readFileSync(process.env.RELAY_TOKENS_FILE ?? ".relay-tokens.json", "utf8"))
console.log("agents:", Object.fromEntries(Object.entries(store.agents).map(([k, v]: any) => [k, v.name])))
process.exit(0)

// Track C: "Ask this camera" against real CameraActor memory.
//   RELAY_AGENT_PREFIX=ct- RELAY_TOKENS_FILE=.relay-tokens.test.json bun scripts/c-ask.ts cam-3 "Did anyone pick something up?"
import { actors } from "../generated/index.js"
import { askCamera } from "../src/relay.ts"

const camId = process.argv[2] ?? "cam-3"
const question = process.argv[3] ?? "Who did you see, and what were they doing?"
const now = Date.now()
const obs = await actors.CameraActor.get(camId).recall(now - 600_000, now)
console.log(`${camId}: ${obs.length} observations in the last 10 min`)
const t0 = Date.now()
const r = await askCamera(camId, question)
console.log(`askCamera ${Date.now() - t0}ms`)
console.log(JSON.stringify(r, null, 2))
const t1 = Date.now()
await askCamera(camId, question) // same memory + question -> cached LLM reply
console.log(`repeat ${Date.now() - t1}ms`)
if (process.env.LINGER) await new Promise(r => setTimeout(r, 30_000)) // let background Relay sends finish
process.exit(0)

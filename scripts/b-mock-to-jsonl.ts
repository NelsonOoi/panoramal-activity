// Track B: writes the mock story as a replayable recording (public/recordings/mock-demo.jsonl).
import { buildMock } from "../src/web/mock"
const items = buildMock(Date.now())
await Bun.write("public/recordings/mock-demo.jsonl", items.map(r => JSON.stringify(r)).join("\n") + "\n")
console.log("wrote", items.length, "events")

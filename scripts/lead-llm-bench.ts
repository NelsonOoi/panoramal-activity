import { readFileSync } from "node:fs"
const img = readFileSync(process.argv[2])
const runs: [string, string, string | undefined][] = [
  ["fast", "gpt-5.4-mini", "none"], ["fast", "gpt-5.4-mini", "low"], ["fast", "gpt-4.1-mini", ""], ["fast", "gpt-5.4-nano", "none"],
  ["smart", "gpt-5.5", "low"], ["smart", "gpt-5.4", "low"],
]
for (const [tier, model, effort] of runs) {
  process.env[tier === "fast" ? "OPENAI_FAST_MODEL" : "OPENAI_SMART_MODEL"] = model
  process.env[tier === "fast" ? "OPENAI_FAST_EFFORT" : "OPENAI_SMART_EFFORT"] = effort ?? ""
  const { llmJson } = await import(`../src/llm.ts?${model}${effort}`)
  const t = Date.now()
  const out = await llmJson({ tier, system: "You describe camera frames.", prompt: `Return JSON {"scene": string, "people": number, "objects": string[]} for this image. nonce ${Date.now()}`, image: tier === "fast" ? img : undefined, maxTokens: 400 })
  console.log(tier, model, effort, Date.now() - t, "ms", JSON.stringify(out)?.slice(0, 120))
}

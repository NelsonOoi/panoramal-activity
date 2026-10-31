import { actors } from "../generated/index.js"
import type { DashEvent } from "./shared/types.js"

// Sends one event to every dashboard socket on SiteActor("site").
export function publish(event: DashEvent): Promise<void> {
    return actors.SiteActor.get("site").publish(event)
}

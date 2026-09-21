import type { MemoryEvent } from "@/game/types";

/** Preserve decisive firsthand evidence even when routine sightings fill memory. */
export function trimMemoryEvents(events: MemoryEvent[]): MemoryEvent[] {
    const recentStart = Math.max(0, events.length - 80);
    return events.filter(
        (event, index) =>
            event.kind === "kill" || event.kind === "vent" || index >= recentStart,
    );
}

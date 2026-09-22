import type { SpeakDecision } from "@/agents/jev-client";
import { trimMemoryEvents } from "@/game/memory";
import type { AgentMemory } from "@/game/types";

function latestPostKillEscape(
    planned: AgentMemory["postKillEscape"],
    live: AgentMemory["postKillEscape"],
): AgentMemory["postKillEscape"] {
    if (!live) return planned;
    if (!planned || live.atTick > planned.atTick) return structuredClone(live);
    return planned;
}

export function mergeAgentMemory(planned: AgentMemory, live: AgentMemory): AgentMemory {
    const merged = structuredClone(planned);
    if (live.lastPlannedAtMs > merged.lastPlannedAtMs) {
        merged.plan = structuredClone(live.plan);
        merged.lastPlannedAtMs = live.lastPlannedAtMs;
    }
    merged.postKillEscape = latestPostKillEscape(
        merged.postKillEscape,
        live.postKillEscape,
    );
    for (const event of live.events.filter(
        (candidate) => candidate.kind === "kill" || candidate.kind === "vent",
    )) {
        const existing = merged.events.find(
            (candidate) =>
                candidate.kind === event.kind &&
                candidate.tick === event.tick &&
                candidate.killerId === event.killerId &&
                candidate.victimId === event.victimId &&
                candidate.ventUserId === event.ventUserId,
        );
        if (existing) {
            if (event.reported) existing.reported = true;
            continue;
        }
        merged.events.push(event);
    }
    merged.events = trimMemoryEvents(merged.events);
    for (const event of merged.events.filter(
        (candidate) => candidate.kind === "kill" || candidate.kind === "vent",
    )) {
        const suspectId = event.killerId ?? event.ventUserId;
        if (suspectId)
            merged.suspicions[suspectId] = Math.max(
                merged.suspicions[suspectId] ?? 0,
                live.suspicions[suspectId] ?? 1,
            );
    }
    return merged;
}

export interface SpeakerCandidate extends SpeakDecision {
    playerId: string;
}

export function selectSpeaker(
    candidates: SpeakerCandidate[],
    random = Math.random,
): string | null {
    const willing = candidates.filter(
        (candidate) => candidate.speak && Number.isFinite(candidate.confidence),
    );
    if (willing.length === 0) return null;
    const highest = Math.max(...willing.map((candidate) => candidate.confidence));
    const tied = willing.filter((candidate) => candidate.confidence === highest);
    return (
        tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]?.playerId ??
        null
    );
}

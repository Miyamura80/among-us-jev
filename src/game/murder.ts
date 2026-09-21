import { hasLineOfSight } from "@/game/map";
import type { Point } from "@/game/types";

const CROWD_RADIUS = 44;
const CROWD_SIZE = 5;

function closeTo(point: Point, other: Point): boolean {
    return Math.hypot(point.x - other.x, point.y - other.y) <= CROWD_RADIUS;
}

/** A tightly stacked group can see a death without distinguishing the killer. */
export function crowdedKillWitness(
    killer: Point,
    victim: Point,
    witness: Point,
    participants: Point[],
): boolean {
    const clustered = participants.filter(
        (position) =>
            closeTo(position, killer) &&
            closeTo(position, victim) &&
            hasLineOfSight(position, killer) &&
            hasLineOfSight(position, victim),
    );
    return clustered.length >= CROWD_SIZE && clustered.includes(witness);
}

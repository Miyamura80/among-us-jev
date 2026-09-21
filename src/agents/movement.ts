import { isolatedKillAction } from "@/agents/jev-client";
import { ACTION } from "@/game/action-space";
import { MOVEMENT_DIRECTIONS, ROOMS, VENTS, nextWaypoint } from "@/game/map";
import { activePlan } from "@/game/plan";
import type { Observation, PlayerState, Point } from "@/game/types";

const POST_KILL_ESCAPE_DISTANCE = 200;

export function visibleCrew(observation: Observation): Observation["players"] {
    const teammates = new Set(observation.knownImpostors.map((player) => player.id));
    return observation.players.filter((player) => !teammates.has(player.id));
}

export function urgentVentMeetingAction(
    observation: Observation,
    player: PlayerState,
): number | null {
    if (
        player.role !== "crewmate" ||
        player.emergencyMeetings <= 0 ||
        !player.memory.events.some((event) => event.kind === "vent" && !event.reported)
    )
        return null;
    if (observation.actionMask[ACTION.CALL_MEETING]) return ACTION.CALL_MEETING;
    const waypoint = nextWaypoint(player.position, "cafeteria");
    return closestLegalMove(observation, player, waypoint);
}

export function saferVentAction(
    observation: Observation,
    player: PlayerState,
    actionId: number,
): number | null {
    if (
        actionId < ACTION.VENT_START ||
        actionId > ACTION.VENT_END ||
        visibleCrew(observation).length === 0
    )
        return null;
    const selected = observation.ventSlots[actionId - ACTION.VENT_START];
    if (player.ventId === null) return movementFallback(observation, player);
    if (selected?.id !== player.ventId) return null;
    const linked = observation.ventSlots.find((vent) => vent.id !== player.ventId);
    return linked ? ACTION.VENT_START + linked.slot : ACTION.STOP;
}

export function taskFallback(observation: Observation): number | null {
    const task = observation.activeTask;
    if (!task) return null;
    if (["scan", "upload"].includes(task.kind)) return ACTION.TASK_CONFIRM;
    if (["card-swipe", "fuel"].includes(task.kind))
        return task.pressed ? ACTION.TASK_RELEASE : ACTION.TASK_PRESS;
    return ACTION.TASK_CLICK_START + task.targetCell;
}

export function closestLegalMove(
    observation: Observation,
    player: PlayerState,
    target: Point,
): number {
    const legalMoves = Object.entries(MOVEMENT_DIRECTIONS)
        .map(([actionId, direction]) => ({
            actionId: Number(actionId),
            distance: Math.hypot(
                target.x - (player.position.x + direction.x * 8),
                target.y - (player.position.y + direction.y * 8),
            ),
        }))
        .filter(({ actionId }) => observation.actionMask[actionId])
        .sort((left, right) => left.distance - right.distance);
    return legalMoves[0]?.actionId ?? ACTION.STOP;
}

/** A visible body takes priority over tasks and strategic movement for crew. */
export function urgentBodyAction(
    observation: Observation,
    player: PlayerState,
): number | null {
    if (player.role !== "crewmate" || observation.bodies.length === 0) return null;
    if (observation.actionMask[ACTION.REPORT_BODY]) return ACTION.REPORT_BODY;
    const body = observation.bodies.reduce((closest, candidate) =>
        Math.hypot(
            candidate.position.x - player.position.x,
            candidate.position.y - player.position.y,
        ) <
        Math.hypot(
            closest.position.x - player.position.x,
            closest.position.y - player.position.y,
        )
            ? candidate
            : closest,
    );
    const move = closestLegalMove(observation, player, body.position);
    return move >= ACTION.MOVE_N && move <= ACTION.MOVE_NW ? move : null;
}

/** System 1 escape takes precedence over a stale plan or an available self-report. */
export function urgentPostKillEscapeAction(
    observation: Observation,
    player: PlayerState,
): number | null {
    if (player.role !== "impostor" || player.killCooldown <= 0) return null;
    const site = player.memory.postKillEscape;
    const body =
        site ??
        observation.bodies.find(
            (candidate) =>
                !candidate.reported &&
                (candidate.roomId === player.roomId ||
                    Math.hypot(
                        candidate.position.x - player.position.x,
                        candidate.position.y - player.position.y,
                    ) <= 80),
        );
    if (!body) return null;
    if (
        player.roomId !== body.roomId &&
        Math.hypot(
            player.position.x - body.position.x,
            player.position.y - body.position.y,
        ) > POST_KILL_ESCAPE_DISTANCE
    )
        return null;
    if (player.ventId !== null) {
        const linked = observation.ventSlots
            .filter((vent) => vent.id !== player.ventId)
            .sort((left, right) => {
                const leftPosition = VENTS.find(
                    (vent) => vent.id === left.id,
                )?.position;
                const rightPosition = VENTS.find(
                    (vent) => vent.id === right.id,
                )?.position;
                const separation = (point: Point | undefined) =>
                    point
                        ? Math.hypot(
                              point.x - body.position.x,
                              point.y - body.position.y,
                          )
                        : 0;
                return separation(rightPosition) - separation(leftPosition);
            })[0];
        return linked ? ACTION.VENT_START + linked.slot : ACTION.STOP;
    }
    const escapeRoom =
        ROOMS.find((room) => room.id === site?.targetRoom) ??
        ROOMS.filter(
            (room) => room.id !== body.roomId && room.id !== player.roomId,
        ).sort(
            (left, right) =>
                Math.hypot(
                    left.x + left.width / 2 - player.position.x,
                    left.y + left.height / 2 - player.position.y,
                ) -
                Math.hypot(
                    right.x + right.width / 2 - player.position.x,
                    right.y + right.height / 2 - player.position.y,
                ),
        )[0];
    if (!escapeRoom) return null;
    if (site) site.targetRoom = escapeRoom.id;
    return closestLegalMove(
        observation,
        player,
        nextWaypoint(player.position, escapeRoom.id),
    );
}

/** Keep crew task traffic spaced while letting impostors close on a visible target. */
export function spreadMove(
    observation: Observation,
    player: PlayerState,
    preferred: number,
    target: Point,
): number {
    if (preferred < ACTION.MOVE_N || preferred > ACTION.MOVE_NW) return preferred;
    if (
        player.role === "impostor" &&
        visibleCrew(observation).some((other) => other.distance < 44)
    )
        return preferred;
    const nearby = observation.players.filter((other) => other.distance < 28);
    if (nearby.length === 0) return preferred;
    const spacing = (actionId: number) => {
        const direction = MOVEMENT_DIRECTIONS[actionId];
        if (!direction) return 0;
        const x = player.position.x + direction.x * 8;
        const y = player.position.y + direction.y * 8;
        return Math.min(
            ...nearby.map((other) =>
                Math.hypot(x - other.position.x, y - other.position.y),
            ),
        );
    };
    const baseline = spacing(preferred);
    if (baseline >= 16) return preferred;
    const dx = target.x - player.position.x;
    const dy = target.y - player.position.y;
    const lane = (Number(player.id.split("-").at(-1)) * 3) % 8;
    const alternatives = Object.entries(MOVEMENT_DIRECTIONS)
        .map(([key, direction]) => {
            const actionId = Number(key);
            const progress = direction.x * dx + direction.y * dy;
            return { actionId, progress, separation: spacing(actionId) };
        })
        .filter(
            ({ actionId, progress, separation }) =>
                observation.actionMask[actionId] &&
                progress >= -0.001 &&
                separation > baseline + 2,
        )
        .sort(
            (left, right) =>
                right.separation - left.separation ||
                right.progress - left.progress ||
                ((left.actionId + lane) % 8) - ((right.actionId + lane) % 8),
        );
    return alternatives[0]?.actionId ?? preferred;
}

function patrolTarget(player: PlayerState): Point | null {
    if (player.roomId !== activePlan(player.memory.plan).targetRoom) return null;
    const room = ROOMS.find((candidate) => candidate.id === player.roomId);
    if (
        !room ||
        player.position.x < room.x + 7 ||
        player.position.x > room.x + room.width - 7 ||
        player.position.y < room.y + 7 ||
        player.position.y > room.y + room.height - 7
    )
        return null;
    const insetX = Math.min(42, room.width * 0.28);
    const insetY = Math.min(36, room.height * 0.28);
    const patrolPoints = [
        { x: room.x + insetX, y: room.y + insetY },
        { x: room.x + room.width - insetX, y: room.y + insetY },
        { x: room.x + room.width - insetX, y: room.y + room.height - insetY },
        { x: room.x + insetX, y: room.y + room.height - insetY },
    ];
    const nearest = patrolPoints.reduce(
        (best, point, index) => {
            const candidate = Math.hypot(
                point.x - player.position.x,
                point.y - player.position.y,
            );
            return candidate < best.distance ? { index, distance: candidate } : best;
        },
        { index: 0, distance: Number.POSITIVE_INFINITY },
    );
    const direction = Number(player.id.split("-").at(-1)) % 2 === 0 ? 1 : -1;
    return (
        patrolPoints[
            (nearest.index + direction + patrolPoints.length) % patrolPoints.length
        ] ?? null
    );
}

export function movementFallback(
    observation: Observation,
    player: PlayerState,
): number {
    const target =
        patrolTarget(player) ??
        nextWaypoint(player.position, activePlan(player.memory.plan).targetRoom);
    const dx = target.x - player.position.x;
    const dy = target.y - player.position.y;
    const horizontal = Math.abs(dx) > 3 ? (dx > 0 ? 1 : -1) : 0;
    const vertical = Math.abs(dy) > 3 ? (dy > 0 ? 1 : -1) : 0;
    const actions: Record<string, number> = {
        "0,-1": ACTION.MOVE_N,
        "1,-1": ACTION.MOVE_NE,
        "1,0": ACTION.MOVE_E,
        "1,1": ACTION.MOVE_SE,
        "0,1": ACTION.MOVE_S,
        "-1,1": ACTION.MOVE_SW,
        "-1,0": ACTION.MOVE_W,
        "-1,-1": ACTION.MOVE_NW,
        "0,0": ACTION.STOP,
    };
    const preferred = actions[`${horizontal},${vertical}`] ?? ACTION.NOOP;
    const legal = observation.actionMask[preferred]
        ? preferred
        : closestLegalMove(observation, player, target);
    return spreadMove(observation, player, legal, target);
}

export function fallbackAction(observation: Observation, player: PlayerState): number {
    if (observation.self.ventId !== null) {
        const current = observation.ventSlots.find(
            (vent) => vent.id === observation.self.ventId,
        );
        const destination = observation.ventSlots.find(
            (vent) =>
                vent.id !== observation.self.ventId &&
                vent.roomId === activePlan(player.memory.plan).targetRoom,
        );
        return ACTION.VENT_START + (destination?.slot ?? current?.slot ?? 0);
    }
    if (player.role === "crewmate" && observation.actionMask[ACTION.REPORT_BODY])
        return ACTION.REPORT_BODY;
    const repair = observation.interactionSlots.find((slot) => slot.kind === "repair");
    if (repair) return ACTION.INTERACT_START + repair.slot;
    const taskAction = taskFallback(observation);
    if (taskAction !== null) return taskAction;
    const isolatedKill = isolatedKillAction(observation);
    if (isolatedKill !== null) return isolatedKill;
    if (
        player.role === "impostor" &&
        visibleCrew(observation).length === 0 &&
        player.roomId !== activePlan(player.memory.plan).targetRoom
    ) {
        const entry = observation.ventSlots[0];
        const linked = VENTS.find((vent) => vent.id === entry?.id)?.links ?? [];
        if (
            linked.some(
                (id) =>
                    VENTS.find((vent) => vent.id === id)?.roomId ===
                    activePlan(player.memory.plan).targetRoom,
            )
        )
            return ACTION.VENT_START + (entry?.slot ?? 0);
    }
    return movementFallback(observation, player);
}

import { ACTION, ACTION_COUNT } from "@/game/action-space";
import {
    MOVEMENT_DIRECTIONS,
    VENTS,
    centerOf,
    hasLineOfSight,
    isWalkable,
} from "@/game/map";
import type {
    GameState,
    InteractionSlot,
    Observation,
    PlayerState,
    Point,
} from "@/game/types";

const INTERACTION_RANGE = 64;
const KILL_RANGE = 58;

function distance(left: Point, right: Point): number {
    return Math.hypot(left.x - right.x, left.y - right.y);
}

function movementPoint(player: PlayerState, actionId: number): Point {
    const direction = MOVEMENT_DIRECTIONS[actionId] ?? { x: 0, y: 0 };
    return {
        x: player.position.x + direction.x * 8,
        y: player.position.y + direction.y * 8,
    };
}

function repairRoom(sabotage: GameState["sabotage"]): string | null {
    const rooms = {
        reactor: "reactor",
        lights: "electrical",
        oxygen: "admin",
        communications: "communications",
    };
    return sabotage ? rooms[sabotage] : null;
}

function getInteractions(state: GameState, player: PlayerState): InteractionSlot[] {
    if (player.ventId !== null) return [];
    const interactions: InteractionSlot[] = [];
    const playerTasks = state.tasks.filter(
        (task) =>
            task.ownerId === player.id &&
            !task.completed &&
            task.roomIds[task.stage] === player.roomId,
    );
    for (const task of playerTasks) {
        if (
            distance(player.position, centerOf(player.roomId)) <=
            INTERACTION_RANGE * 2
        ) {
            interactions.push({
                slot: interactions.length,
                kind: "task",
                entityId: task.id,
                label: task.kind,
            });
        }
    }
    if (state.sabotage) {
        if (player.roomId === repairRoom(state.sabotage)) {
            interactions.push({
                slot: interactions.length,
                kind: "repair",
                entityId: state.sabotage,
                label: `Repair ${state.sabotage}`,
            });
        }
    }
    if (player.human && player.roomId === "cafeteria" && player.emergencyMeetings > 0) {
        interactions.push({
            slot: interactions.length,
            kind: "emergency",
            entityId: "cafeteria-button",
            label: "Emergency meeting",
        });
    }
    return interactions
        .slice(0, 8)
        .map((interaction, slot) => ({ ...interaction, slot }));
}

function addMovementActions(
    mask: boolean[],
    state: GameState,
    player: PlayerState,
): void {
    for (let actionId = ACTION.MOVE_N; actionId <= ACTION.MOVE_NW; actionId += 1) {
        const destination = movementPoint(player, actionId);
        const closedRoom = state.doors.find(
            (door) =>
                door.roomId === player.roomId && door.closedUntilTick > state.tick,
        );
        mask[actionId] =
            player.ventId === null && !closedRoom && isWalkable(destination);
    }
    mask[ACTION.STOP] = true;
}

function addImpostorActions(
    mask: boolean[],
    state: GameState,
    player: PlayerState,
    observation: Observation,
): void {
    if (
        player.killCooldown <= 0 &&
        player.ventId === null &&
        Date.now() >= state.firstKillAtMs
    ) {
        for (const visible of observation.players) {
            const target = state.players.find(
                (candidate) => candidate.id === visible.id,
            );
            if (
                target?.role === "crewmate" &&
                distance(player.position, target.position) <= KILL_RANGE
            ) {
                mask[ACTION.KILL_START + visible.slot] = true;
            }
        }
    }
    for (const vent of observation.ventSlots) {
        mask[ACTION.VENT_START + vent.slot] = true;
    }
    if (state.sabotage === null && Date.now() >= state.firstKillAtMs) {
        for (let index = 0; index < 4; index += 1) {
            mask[ACTION.SABOTAGE_START + index] = true;
        }
    }
    for (const [index, door] of state.doors.slice(0, 20).entries()) {
        mask[ACTION.DOOR_START + index] = door.closedUntilTick <= state.tick;
    }
}

function createMask(
    state: GameState,
    player: PlayerState,
    observation: Observation,
): boolean[] {
    const mask = Array.from({ length: ACTION_COUNT }, () => false);
    mask[ACTION.NOOP] = true;
    if (!player.alive || state.phase !== "action") return mask;
    if (player.ventId !== null) {
        mask[ACTION.STOP] = true;
        if (player.role === "impostor")
            addImpostorActions(mask, state, player, observation);
        return mask;
    }
    addMovementActions(mask, state, player);
    for (const interaction of observation.interactionSlots) {
        mask[ACTION.INTERACT_START + interaction.slot] = true;
    }
    mask[ACTION.REPORT_BODY] = observation.bodies.some(
        (body) => distance(body.position, player.position) <= INTERACTION_RANGE,
    );
    mask[ACTION.CALL_MEETING] =
        player.roomId === "cafeteria" &&
        player.emergencyMeetings > 0 &&
        (player.human ||
            observation.bodies.length > 0 ||
            player.memory.events.some(
                (event) => event.kind === "vent" && !event.reported,
            ));
    if (player.role === "impostor") {
        addImpostorActions(mask, state, player, observation);
    }

    if (observation.activeTask) {
        for (let id = ACTION.TASK_CLICK_START; id <= ACTION.TASK_CLICK_END; id += 1) {
            mask[id] = true;
        }
        for (let id = ACTION.TASK_CURSOR_UP; id <= ACTION.TASK_CANCEL; id += 1) {
            mask[id] = true;
        }
    }
    return mask;
}

export function observeGame(state: GameState, playerId: string): Observation {
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error(`Unknown player ${playerId}`);
    const vision =
        state.sabotage === "lights"
            ? state.settings.visionRadius * 0.3
            : state.settings.visionRadius;
    const players = state.players
        .filter(
            (candidate) =>
                candidate.id !== player.id &&
                candidate.alive &&
                candidate.ventId === null &&
                distance(player.position, candidate.position) <= vision &&
                hasLineOfSight(player.position, candidate.position),
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, 15)
        .map((candidate, slot) => ({
            slot,
            id: candidate.id,
            name: candidate.name,
            color: candidate.color,
            alive: candidate.alive,
            position: { ...candidate.position },
            roomId: candidate.roomId,
            distance: distance(player.position, candidate.position),
        }));
    const bodies = state.bodies.filter(
        (body) =>
            !body.reported &&
            distance(player.position, body.position) <= vision &&
            hasLineOfSight(player.position, body.position),
    );
    const interactionSlots = getInteractions(state, player);
    const nearbyVent = VENTS.find(
        (vent) =>
            vent.roomId === player.roomId &&
            distance(vent.position, player.position) <= INTERACTION_RANGE,
    );
    const currentVent = VENTS.find((vent) => vent.id === player.ventId);
    const accessibleVents = currentVent
        ? VENTS.filter(
              (vent) =>
                  vent.id === currentVent.id || currentVent.links.includes(vent.id),
          )
        : nearbyVent
          ? [nearbyVent]
          : [];
    const activeTask =
        (player.ventId === null ? state.tasks : []).find(
            (task) =>
                task.ownerId === player.id &&
                !task.completed &&
                task.roomIds[task.stage] === player.roomId &&
                distance(player.position, centerOf(player.roomId)) <=
                    INTERACTION_RANGE * 2,
        ) ?? null;
    const ownTasks = state.tasks.filter((task) => task.ownerId === player.id);
    const nextTask = ownTasks.find((task) => !task.completed);
    const observation: Observation = {
        gameId: state.id,
        tick: state.tick,
        phase: state.phase,
        visionRadius: vision,
        crewTaskProgress: {
            completed: state.tasks.filter((task) => task.completed).length,
            total: state.tasks.length,
        },
        self: {
            id: player.id,
            role: player.role,
            alive: player.alive,
            position: { ...player.position },
            roomId: player.roomId,
            killCooldown: player.killCooldown,
            ventId: player.ventId,
        },
        players,
        knownImpostors:
            player.role === "impostor"
                ? state.players
                      .filter(
                          (candidate) =>
                              candidate.role === "impostor" &&
                              candidate.id !== player.id,
                      )
                      .map((candidate) => ({
                          id: candidate.id,
                          name: candidate.name,
                          alive: candidate.alive,
                      }))
                : [],
        bodies: structuredClone(bodies),
        interactionSlots,
        ventSlots: accessibleVents.slice(0, 10).map((vent, slot) => ({
            slot,
            id: vent.id,
            roomId: vent.roomId,
        })),
        sabotage: state.sabotage,
        sabotageDeadline: state.sabotageDeadline,
        meetingReason: state.meeting?.reason ?? null,
        meetingReporterId: state.meeting?.reporterId ?? null,
        activeTask: activeTask ? structuredClone(activeTask) : null,
        taskProgress: {
            completed: ownTasks.filter((task) => task.completed).length,
            total: ownTasks.length,
        },
        nextTask: nextTask
            ? {
                  kind: nextTask.kind,
                  roomId: nextTask.roomIds[nextTask.stage] ?? player.roomId,
              }
            : null,
        actionMask: [],
    };
    observation.actionMask = createMask(state, player, observation);
    return observation;
}

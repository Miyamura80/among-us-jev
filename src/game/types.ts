export type Role = "crewmate" | "impostor";
export type GamePhase = "action" | "meeting" | "ejection" | "finished";
export type SabotageKind = "reactor" | "oxygen" | "lights" | "communications";
export type TaskKind =
    | "wires"
    | "card-swipe"
    | "upload"
    | "asteroids"
    | "fuel"
    | "manifolds"
    | "navigation"
    | "scan";

export interface Point {
    x: number;
    y: number;
}

export interface AgentMemory {
    events: MemoryEvent[];
    suspicions: Record<string, number>;
    plan: AgentPlan;
    lastPlannedAtMs: number;
    postKillEscape?: {
        victimId: string;
        roomId: string;
        position: Point;
        atTick: number;
        targetRoom?: string;
    } | null;
}

export interface MemoryEvent {
    tick: number;
    kind: "sighting" | "body" | "kill" | "vent" | "task" | "meeting" | "sabotage";
    summary: string;
    killerId?: string;
    victimId?: string;
    ventUserId?: string;
    reported?: boolean;
}

export interface PlanOption {
    goal: string;
    targetRoom: string;
    rationale: string;
}

export interface AgentPlan extends PlanOption {
    alternative?: PlanOption & { trigger: string };
    active?: "A" | "B";
    validUntilTick: number;
}

export interface PlayerState {
    id: string;
    name: string;
    role: Role;
    human: boolean;
    alive: boolean;
    connected: boolean;
    position: Point;
    roomId: string;
    color: string;
    killCooldown: number;
    emergencyMeetings: number;
    ventId: string | null;
    taskIds: string[];
    memory: AgentMemory;
}

export interface TaskState {
    id: string;
    ownerId: string;
    kind: TaskKind;
    roomIds: string[];
    stage: number;
    completed: boolean;
    targetCell: number;
    cursor: number;
    pressed: boolean;
}

export interface BodyState {
    playerId: string;
    position: Point;
    roomId: string;
    reported: boolean;
    createdAtTick: number;
}

export interface DoorState {
    id: string;
    roomId: string;
    closedUntilTick: number;
}

export interface MeetingState {
    reason: string;
    reporterId: string;
    bodyId: string | null;
    stage: "discussion" | "voting";
    transcript: DiscussionMessage[];
    votes: Record<string, string | null>;
    endsAtTick: number;
    discussionEndsAtMs?: number;
}

export interface EjectionState {
    votes: Record<string, string | null>;
    ejectedId: string | null;
    endsAtMs: number;
}

export interface DiscussionMessage {
    playerId: string;
    text: string;
}

export interface GameSettings {
    playerCount: number;
    impostorCount: number;
    humanPlayers: number;
    killCooldownTicks: number;
    discussionTicks: number;
    tasksPerCrewmate: number;
    visionRadius: number;
    systemTwoModel: string;
}

export interface GameState {
    id: string;
    seed: number;
    tick: number;
    firstKillAtMs: number;
    phase: GamePhase;
    players: PlayerState[];
    tasks: TaskState[];
    bodies: BodyState[];
    doors: DoorState[];
    sabotage: SabotageKind | null;
    sabotageDeadline: number | null;
    meeting: MeetingState | null;
    ejection: EjectionState | null;
    winner: Role | null;
    settings: GameSettings;
}

export interface ObservedPlayer {
    slot: number;
    id: string;
    name: string;
    color: string;
    alive: boolean;
    position: Point;
    roomId: string;
    distance: number;
}

export interface InteractionSlot {
    slot: number;
    kind: "task" | "emergency" | "repair";
    entityId: string;
    label: string;
}

export interface Observation {
    gameId: string;
    tick: number;
    phase: GamePhase;
    visionRadius: number;
    crewTaskProgress: { completed: number; total: number };
    self: {
        id: string;
        role: Role;
        alive: boolean;
        position: Point;
        roomId: string;
        killCooldown: number;
        ventId: string | null;
    };
    players: ObservedPlayer[];
    knownImpostors: { id: string; name: string; alive: boolean }[];
    bodies: BodyState[];
    interactionSlots: InteractionSlot[];
    ventSlots: { slot: number; id: string; roomId: string }[];
    sabotage: SabotageKind | null;
    sabotageDeadline: number | null;
    meetingReason: string | null;
    meetingReporterId: string | null;
    activeTask: TaskState | null;
    taskProgress: { completed: number; total: number };
    nextTask: { kind: TaskKind; roomId: string } | null;
    actionMask: boolean[];
}

export interface StepResult {
    state: GameState;
    accepted: boolean;
    actionId: number;
    events: MemoryEvent[];
    error?: string;
}

export const ACTION_COUNT = 255;

export const ACTION = {
    NOOP: 0,
    MOVE_N: 1,
    MOVE_NE: 2,
    MOVE_E: 3,
    MOVE_SE: 4,
    MOVE_S: 5,
    MOVE_SW: 6,
    MOVE_W: 7,
    MOVE_NW: 8,
    STOP: 9,
    INTERACT_START: 10,
    INTERACT_END: 17,
    REPORT_BODY: 18,
    CALL_MEETING: 19,
    KILL_START: 20,
    KILL_END: 34,
    ABILITY_START: 35,
    ABILITY_END: 49,
    VENT_START: 50,
    VENT_END: 59,
    SABOTAGE_START: 60,
    SABOTAGE_END: 79,
    DOOR_START: 80,
    DOOR_END: 99,
    TASK_CLICK_START: 100,
    TASK_CLICK_END: 163,
    TASK_CURSOR_UP: 164,
    TASK_CURSOR_DOWN: 165,
    TASK_CURSOR_LEFT: 166,
    TASK_CURSOR_RIGHT: 167,
    TASK_PRESS: 168,
    TASK_RELEASE: 169,
    TASK_CONFIRM: 170,
    TASK_CANCEL: 171,
    RESERVED_START: 172,
    RESERVED_END: 254,
} as const;

const FIXED_LABELS = [
    "NOOP",
    "MOVE_N",
    "MOVE_NE",
    "MOVE_E",
    "MOVE_SE",
    "MOVE_S",
    "MOVE_SW",
    "MOVE_W",
    "MOVE_NW",
    "STOP",
];

export function actionLabel(actionId: number): string {
    if (actionId < 0 || actionId >= ACTION_COUNT) return "INVALID";
    if (actionId <= ACTION.STOP) return FIXED_LABELS[actionId] ?? "INVALID";
    const exact: Record<number, string> = {
        18: "REPORT_BODY",
        19: "CALL_EMERGENCY_MEETING",
        164: "TASK_CURSOR_UP",
        165: "TASK_CURSOR_DOWN",
        166: "TASK_CURSOR_LEFT",
        167: "TASK_CURSOR_RIGHT",
        168: "TASK_PRESS",
        169: "TASK_RELEASE",
        170: "TASK_CONFIRM",
        171: "TASK_CANCEL",
    };
    if (exact[actionId]) return exact[actionId];
    const ranges: [number, number, string][] = [
        [10, 17, "INTERACT_SLOT"],
        [20, 34, "KILL_PLAYER"],
        [35, 49, "ABILITY_PLAYER"],
        [50, 59, "VENT_SLOT"],
        [60, 79, "SABOTAGE"],
        [80, 99, "DOOR"],
        [100, 163, "TASK_CLICK"],
    ];
    const range = ranges.find(([start, end]) => actionId >= start && actionId <= end);
    if (range) return `${range[2]}_${actionId - range[0]}`;
    return `RESERVED_${actionId}`;
}

export function enabledActionIds(mask: boolean[]): number[] {
    return mask.flatMap((enabled, actionId) => (enabled ? [actionId] : []));
}

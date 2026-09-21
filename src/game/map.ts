import type { Point } from "./types";

export interface MapArea {
    id: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Vent {
    id: string;
    roomId: string;
    position: Point;
    links: string[];
}

export const MOVEMENT_DIRECTIONS: Record<number, Point> = {
    1: { x: 0, y: -1 },
    2: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
    3: { x: 1, y: 0 },
    4: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    5: { x: 0, y: 1 },
    6: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
    7: { x: -1, y: 0 },
    8: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
};

export const ROOMS: MapArea[] = [
    { id: "cafeteria", label: "Cafeteria", x: 350, y: 45, width: 300, height: 180 },
    { id: "weapons", label: "Weapons", x: 715, y: 65, width: 145, height: 150 },
    { id: "o2", label: "O2", x: 710, y: 265, width: 85, height: 100 },
    { id: "navigation", label: "Navigation", x: 865, y: 290, width: 115, height: 140 },
    { id: "shields", label: "Shields", x: 715, y: 475, width: 145, height: 150 },
    { id: "communications", label: "Comms", x: 555, y: 600, width: 150, height: 95 },
    { id: "storage", label: "Storage", x: 390, y: 405, width: 255, height: 185 },
    { id: "admin", label: "Admin", x: 590, y: 285, width: 100, height: 110 },
    { id: "electrical", label: "Electrical", x: 245, y: 430, width: 130, height: 100 },
    {
        id: "lower-engine",
        label: "Lower Engine",
        x: 80,
        y: 515,
        width: 145,
        height: 150,
    },
    { id: "security", label: "Security", x: 195, y: 305, width: 90, height: 100 },
    { id: "reactor", label: "Reactor", x: 20, y: 305, width: 105, height: 150 },
    {
        id: "upper-engine",
        label: "Upper Engine",
        x: 80,
        y: 90,
        width: 145,
        height: 145,
    },
    { id: "medbay", label: "MedBay", x: 300, y: 245, width: 140, height: 115 },
];

export const CORRIDORS: MapArea[] = [
    // Upper and lower engine hallways are separate from the reactor itself.
    { id: "upper-west-hall", label: "", x: 205, y: 160, width: 160, height: 45 },
    { id: "west-spine", label: "", x: 130, y: 210, width: 45, height: 330 },
    { id: "reactor-hall", label: "", x: 110, y: 340, width: 100, height: 45 },
    { id: "medbay-north-hall", label: "", x: 335, y: 190, width: 45, height: 75 },
    // Electrical has one south doorway, onto the Lower Engine–Storage hallway.
    { id: "electrical-hall", label: "", x: 290, y: 515, width: 45, height: 45 },
    { id: "lower-west-hall", label: "", x: 205, y: 545, width: 200, height: 45 },
    // Cafeteria branches toward Weapons and Storage, rather than crossing rooms.
    { id: "weapons-hall", label: "", x: 635, y: 125, width: 95, height: 45 },
    { id: "storage-north-hall", label: "", x: 495, y: 210, width: 50, height: 215 },
    { id: "admin-hall", label: "", x: 625, y: 380, width: 75, height: 45 },
    { id: "comms-hall", label: "", x: 585, y: 575, width: 50, height: 45 },
    { id: "shields-hall", label: "", x: 625, y: 535, width: 105, height: 45 },
    // The east hallway runs past O2 and Navigation to Shields.
    { id: "east-spine", label: "", x: 815, y: 200, width: 45, height: 290 },
    { id: "o2-hall", label: "", x: 780, y: 295, width: 50, height: 45 },
    { id: "navigation-hall", label: "", x: 845, y: 340, width: 40, height: 45 },
];

export const VENTS: Vent[] = [
    {
        id: "vent-upper-engine",
        roomId: "upper-engine",
        position: { x: 160, y: 170 },
        links: ["vent-reactor-north"],
    },
    {
        id: "vent-reactor-north",
        roomId: "reactor",
        position: { x: 65, y: 340 },
        links: ["vent-upper-engine"],
    },
    {
        id: "vent-reactor-south",
        roomId: "reactor",
        position: { x: 65, y: 420 },
        links: ["vent-lower-engine"],
    },
    {
        id: "vent-lower-engine",
        roomId: "lower-engine",
        position: { x: 160, y: 585 },
        links: ["vent-reactor-south"],
    },
    {
        id: "vent-security",
        roomId: "security",
        position: { x: 260, y: 380 },
        links: ["vent-electrical", "vent-medbay"],
    },
    {
        id: "vent-electrical",
        roomId: "electrical",
        position: { x: 300, y: 500 },
        links: ["vent-security", "vent-medbay"],
    },
    {
        id: "vent-medbay",
        roomId: "medbay",
        position: { x: 345, y: 300 },
        links: ["vent-security", "vent-electrical"],
    },
    {
        id: "vent-cafeteria",
        roomId: "cafeteria",
        position: { x: 565, y: 175 },
        links: ["vent-admin", "vent-hallway"],
    },
    {
        id: "vent-admin",
        roomId: "admin",
        position: { x: 680, y: 340 },
        links: ["vent-cafeteria", "vent-hallway"],
    },
    {
        id: "vent-hallway",
        // Corridor positions resolve to their nearest named room in roomAt().
        roomId: "shields",
        position: { x: 837, y: 445 },
        links: ["vent-cafeteria", "vent-admin"],
    },
    {
        id: "vent-weapons",
        roomId: "weapons",
        position: { x: 790, y: 150 },
        links: ["vent-navigation-north"],
    },
    {
        id: "vent-navigation-north",
        roomId: "navigation",
        position: { x: 925, y: 325 },
        links: ["vent-weapons"],
    },
    {
        id: "vent-navigation-south",
        roomId: "navigation",
        position: { x: 925, y: 395 },
        links: ["vent-shields"],
    },
    {
        id: "vent-shields",
        roomId: "shields",
        position: { x: 785, y: 550 },
        links: ["vent-navigation-south"],
    },
];

export function centerOf(roomId: string): Point {
    const room = ROOMS.find((candidate) => candidate.id === roomId) ?? ROOMS[0];
    if (!room) return { x: 500, y: 135 };
    return { x: room.x + room.width / 2, y: room.y + room.height / 2 };
}

function contains(area: MapArea, point: Point, padding = 10): boolean {
    return (
        point.x >= area.x + padding &&
        point.x <= area.x + area.width - padding &&
        point.y >= area.y + padding &&
        point.y <= area.y + area.height - padding
    );
}

export function isWalkable(point: Point): boolean {
    return (
        ROOMS.some((area) => contains(area, point, 7)) ||
        CORRIDORS.some((area) => contains(area, point, 7))
    );
}

function visibleRayEnd(from: Point, to: Point): Point {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const samples = Math.ceil(distance / 4);
    let last = from;
    for (let index = 1; index <= samples; index += 1) {
        const fraction = index / samples;
        const point = {
            x: from.x + (to.x - from.x) * fraction,
            y: from.y + (to.y - from.y) * fraction,
        };
        if (!isWalkable(point)) return last;
        last = point;
    }
    return to;
}

export function hasLineOfSight(from: Point, to: Point): boolean {
    const end = visibleRayEnd(from, to);
    return end.x === to.x && end.y === to.y;
}

/** Visibility perimeter for the client fog mask, using the authoritative wall test. */
export function visibilityBoundary(origin: Point, radius: number, rays = 180): Point[] {
    return Array.from({ length: rays }, (_, index) => {
        const angle = (index / rays) * Math.PI * 2;
        return visibleRayEnd(origin, {
            x: origin.x + Math.cos(angle) * radius,
            y: origin.y + Math.sin(angle) * radius,
        });
    });
}

export function roomAt(point: Point): string {
    const containing = ROOMS.find((room) => contains(room, point, 0));
    if (containing) return containing.id;
    return ROOMS.reduce(
        (closest, room) => {
            const center = centerOf(room.id);
            const distance = Math.hypot(point.x - center.x, point.y - center.y);
            return distance < closest.distance ? { id: room.id, distance } : closest;
        },
        { id: "cafeteria", distance: Number.POSITIVE_INFINITY },
    ).id;
}

const GRID_SIZE = 16;
const GRID_COLUMNS = Math.ceil(1000 / GRID_SIZE);
const GRID_ROWS = Math.ceil(720 / GRID_SIZE);
const GRID_DIRECTIONS = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
] as const;

function gridPoint(index: number): Point {
    return {
        x: (index % GRID_COLUMNS) * GRID_SIZE + GRID_SIZE / 2,
        y: Math.floor(index / GRID_COLUMNS) * GRID_SIZE + GRID_SIZE / 2,
    };
}

function cellAt(column: number, row: number): number {
    if (column < 0 || column >= GRID_COLUMNS || row < 0 || row >= GRID_ROWS) return -1;
    return row * GRID_COLUMNS + column;
}

function nearestWalkableCell(point: Point): number {
    const column = Math.max(
        0,
        Math.min(GRID_COLUMNS - 1, Math.floor(point.x / GRID_SIZE)),
    );
    const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(point.y / GRID_SIZE)));
    const index = row * GRID_COLUMNS + column;
    if (isWalkable(gridPoint(index))) return index;
    for (let radius = 1; radius < 5; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                const candidate = cellAt(column + dx, row + dy);
                if (candidate >= 0 && isWalkable(gridPoint(candidate)))
                    return candidate;
            }
        }
    }
    return index;
}

function isPassableNeighbor(
    column: number,
    row: number,
    dx: number,
    dy: number,
): boolean {
    const next = cellAt(column + dx, row + dy);
    if (next < 0 || !isWalkable(gridPoint(next))) return false;
    if (dx === 0 || dy === 0) return true;
    return (
        isWalkable(gridPoint(cellAt(column + dx, row))) &&
        isWalkable(gridPoint(cellAt(column, row + dy)))
    );
}

function pathParents(start: number, goal: number): Int32Array {
    const queue = [start];
    const previous = new Int32Array(GRID_COLUMNS * GRID_ROWS).fill(-1);
    previous[start] = start;
    for (let head = 0; head < queue.length && previous[goal] === -1; head += 1) {
        const current = queue[head];
        if (current === undefined) break;
        const column = current % GRID_COLUMNS;
        const row = Math.floor(current / GRID_COLUMNS);
        for (const [dx, dy] of GRID_DIRECTIONS) {
            const candidate = cellAt(column + dx, row + dy);
            if (
                candidate < 0 ||
                previous[candidate] !== -1 ||
                !isPassableNeighbor(column, row, dx, dy)
            )
                continue;
            previous[candidate] = current;
            queue.push(candidate);
        }
    }
    return previous;
}

/** Next walkable waypoint toward a room, respecting the same geometry drawn by the UI. */
export function nextWaypoint(from: Point, targetRoom: string): Point {
    const start = nearestWalkableCell(from);
    const goal = nearestWalkableCell(centerOf(targetRoom));
    if (start === goal) return centerOf(targetRoom);
    const previous = pathParents(start, goal);
    if (previous[goal] === -1) return centerOf(targetRoom);
    let waypoint = goal;
    while (previous[waypoint] !== start && previous[waypoint] !== waypoint) {
        waypoint = previous[waypoint] ?? start;
    }
    return gridPoint(waypoint);
}

import sharp from "sharp";

import { CORRIDORS, ROOMS, VENTS } from "@/game/map";
import type { Observation } from "@/game/types";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 720;

function escapeXml(value: string): string {
    return value.replace(/[<>&"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Draw only what the observing player can see, as an SVG top-down view. */
export function observationSvg(observation: Observation): string {
    const { self, visionRadius } = observation;
    const areas = [...ROOMS, ...CORRIDORS]
        .map(
            (area) =>
                `<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" fill="#2b3245" stroke="#5c6680" stroke-width="2"/>`,
        )
        .join("");
    const labels = ROOMS.map(
        (room) =>
            `<text x="${room.x + 6}" y="${room.y + 18}" font-size="14" fill="#c8cfdc" font-family="sans-serif">${escapeXml(room.label)}</text>`,
    ).join("");
    const vents = VENTS.map(
        (vent) =>
            `<rect x="${vent.position.x - 7}" y="${vent.position.y - 5}" width="14" height="10" fill="#505868"/>`,
    ).join("");
    const bodies = observation.bodies
        .map(
            (body) =>
                `<g stroke="#ff3b30" stroke-width="4"><line x1="${body.position.x - 9}" y1="${body.position.y - 9}" x2="${body.position.x + 9}" y2="${body.position.y + 9}"/><line x1="${body.position.x + 9}" y1="${body.position.y - 9}" x2="${body.position.x - 9}" y2="${body.position.y + 9}"/></g>`,
        )
        .join("");
    const teammates = new Set(observation.knownImpostors.map((player) => player.id));
    const players = observation.players
        .map((player) => {
            const ring = teammates.has(player.id)
                ? ' stroke="#ff3b30" stroke-width="3"'
                : "";
            return `<circle cx="${player.position.x}" cy="${player.position.y}" r="10" fill="${escapeXml(player.color)}"${ring}/><text x="${player.position.x + 12}" y="${player.position.y - 10}" font-size="12" fill="#ffffff" font-family="sans-serif">${escapeXml(player.id)}</text>`;
        })
        .join("");
    const selfMarker = `<circle cx="${self.position.x}" cy="${self.position.y}" r="12" fill="#ffffff" stroke="#ffd60a" stroke-width="4"/><text x="${self.position.x + 14}" y="${self.position.y + 4}" font-size="13" fill="#ffd60a" font-family="sans-serif">YOU</text>`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}">`,
        `<rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="#0b0e17"/>`,
        areas,
        labels,
        vents,
        `<circle cx="${self.position.x}" cy="${self.position.y}" r="${visionRadius}" fill="#ffd60a" fill-opacity="0.08" stroke="#ffd60a" stroke-opacity="0.5" stroke-dasharray="6 6"/>`,
        bodies,
        players,
        selfMarker,
        "</svg>",
    ].join("");
}

/** PNG of the player's view, sized to stay inside Clef-omni's per-image token cap. */
export async function observationPng(
    observation: Observation,
    width = 640,
): Promise<Buffer> {
    return sharp(Buffer.from(observationSvg(observation)))
        .resize({ width })
        .png()
        .toBuffer();
}

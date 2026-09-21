import { useState } from "react"

export interface MapTask { kind: string; roomIds: string[]; stage: number; completed: boolean }
interface Station { kind: string; room: string; x: number; y: number; label: string }

const STATIONS: Station[] = [
  { kind: "wires", room: "electrical", x: 346, y: 462, label: "Fix wiring" },
  { kind: "wires", room: "admin", x: 609, y: 371, label: "Fix wiring" },
  { kind: "wires", room: "navigation", x: 884, y: 411, label: "Fix wiring" },
  { kind: "card-swipe", room: "admin", x: 664, y: 316, label: "Swipe card" },
  { kind: "upload", room: "weapons", x: 743, y: 185, label: "Download data" },
  { kind: "upload", room: "communications", x: 581, y: 644, label: "Upload data" },
  { kind: "asteroids", room: "weapons", x: 830, y: 166, label: "Clear asteroids" },
  { kind: "fuel", room: "storage", x: 576, y: 493, label: "Fill fuel can" },
  { kind: "fuel", room: "upper-engine", x: 193, y: 119, label: "Fuel engine" },
  { kind: "fuel", room: "lower-engine", x: 193, y: 629, label: "Fuel engine" },
  { kind: "manifolds", room: "reactor", x: 88, y: 384, label: "Unlock manifolds" },
  { kind: "navigation", room: "navigation", x: 919, y: 362, label: "Chart course" },
  { kind: "scan", room: "medbay", x: 382, y: 323, label: "Submit scan" },
]

function StationArtwork({ kind }: { kind: string }) {
  if (kind === "scan") return <><ellipse cy="5" rx="20" ry="12" fill="#627981" /><ellipse rx="20" ry="12" fill="#a5c4c0" /><ellipse rx="14" ry="8" fill="#61a995" /><path d="M-8 0H8M0-5V5" stroke="#c0e6b4" strokeWidth="2" /><path d="M-21-11V-23H-12" fill="none" stroke="#8faaa9" strokeWidth="4" /></>
  if (kind === "fuel") return <><path d="M-10-8H7L12-3V14H-12V-5ZM-5-8V-14H5V-8" fill="#ccaa58" stroke="#63553d" strokeWidth="2" /><path d="M-6-2L6 9M6-2L-6 9" stroke="#9a7739" /><path d="M8-10H15V-5" fill="none" stroke="#bcc5b0" strokeWidth="4" /></>
  return <><rect x="-16" y="-15" width="32" height="29" rx="3" fill="#637984" stroke="#203540" strokeWidth="2" /><rect x="-12" y="-11" width="24" height="18" rx="1" fill="#172d38" />
    {kind === "wires" ? <g fill="none" strokeWidth="2"><path d="M-10-7H-5L5 4H10" stroke="#e07268" /><path d="M-10-2H-4L4-7H10" stroke="#e5c060" /><path d="M-10 4H-6L6-2H10" stroke="#77b9d9" /></g> : kind === "card-swipe" ? <><rect x="-8" y="-8" width="14" height="10" rx="1" fill="#d9d9bb" /><path d="M-6-4H4" stroke="#648799" strokeWidth="2" /><path d="M-10 5H10" stroke="#d9b869" /></> : kind === "asteroids" ? <g stroke="#9ecda8" fill="none"><circle cy="-2" r="6" /><path d="M0-10V6M-9-2H9" /><circle cx="-8" cy="-7" r="2" fill="#afb48a" /></g> : kind === "navigation" ? <><path d="M-9 3L-4-5L3 1L9-7" fill="none" stroke="#8ed5df" /><circle cx="9" cy="-7" r="2" fill="#d2d6a6" /></> : kind === "manifolds" ? <g fill="#9cc6aa">{Array.from({ length: 6 }, (_, i) => <rect key={i} x={-9 + i % 3 * 7} y={-8 + Math.floor(i / 3) * 7} width="4" height="4" />)}</g> : <><path d="M0 4V-7M-5-2L0-7L5-2M-8 3V6H8V3" fill="none" stroke="#8ecbc4" strokeWidth="2" /></>}
    <path d="M-9 10H3" stroke="#9eafa7" /><circle cx="9" cy="10" r="1.5" fill="#a4c89b" />
  </>
}

export function ShipTaskStations({ tasks = [] }: { tasks?: MapTask[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return <g className="ship-task-stations">{STATIONS.map((station) => {
    const id = `${station.room}-${station.kind}`
    const assigned = tasks.filter((task) => task.kind === station.kind && task.roomIds.includes(station.room))
    const pending = assigned.some((task) => !task.completed && task.roomIds[task.stage] === station.room)
    const completed = assigned.length > 0 && assigned.every((task) => task.completed || task.roomIds.indexOf(station.room) < task.stage)
    const label = `${station.label}${pending ? " · pending" : completed ? " · complete" : ""}`
    return <g key={id} className={`task-station${pending ? " pending" : ""}${completed ? " complete" : ""}`} transform={`translate(${station.x} ${station.y})`} role="button" tabIndex={0} aria-label={label} aria-pressed={selected === id} onClick={() => setSelected(selected === id ? null : id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(selected === id ? null : id) } }}>
      <title>{label}</title><rect className="station-outline" x="-22" y="-25" width="44" height="44" rx="6" /><StationArtwork kind={station.kind} />
      {pending && <g className="station-status" transform="translate(19 -19)"><circle r="6" /><path d="M0-3V1M0 3V4" /></g>}
      {completed && <path className="station-check" d="M13-20L17-16L24-24" />}
      {(selected === id || pending) && <g className="station-caption"><rect x={-station.label.length * 2.5 - 5} y="22" width={station.label.length * 5 + 10} height="13" rx="3" /><text y="31" textAnchor="middle">{station.label}</text></g>}
    </g>
  })}</g>
}

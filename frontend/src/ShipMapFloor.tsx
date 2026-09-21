import { useId, type ReactNode } from "react"
import { CORRIDORS, ROOMS, VENTS } from "../../src/game/map"
import { ShipProps } from "./ShipProps"
import { ShipTaskStations, type MapTask } from "./ShipTaskStations"

const ROOM_COLORS: Record<string, string> = { cafeteria: "#30434e", weapons: "#465348", o2: "#425b52", navigation: "#344854", shields: "#3f5362", communications: "#514b40", storage: "#48534a", admin: "#54494c", electrical: "#4d4c42", "lower-engine": "#4b4645", security: "#3a4d43", reactor: "#45445a", "upper-engine": "#4b4645", medbay: "#45616a" }

export function ShipMapFloor({ activeRoomId, tasks, children }: { activeRoomId?: string | null; tasks?: MapTask[]; children?: ReactNode }) {
  const mapId = useId()
  const floorId = `${mapId}-floor`
  const gridId = `${mapId}-grid`
  const areas = [...CORRIDORS, ...ROOMS]
  return <svg className="ship-map" viewBox="0 0 1000 720" role="group" aria-label="The Skeld deck map">
    <defs>
      <pattern id={gridId} width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#b9cecc" strokeOpacity=".12" /><path d="M1 24V1H24" fill="none" stroke="#0b1724" strokeOpacity=".18" /></pattern>
      <clipPath id={floorId}>{areas.map((area) => <rect key={area.id} x={area.x} y={area.y} width={area.width} height={area.height} />)}</clipPath>
    </defs>
    {/* Paint every wall first, then the connected floors so doorways remain open. */}
    <g fill="none" stroke="#15232c" strokeWidth="12" aria-hidden="true">
      {areas.map((area) => <rect key={area.id} x={area.x} y={area.y} width={area.width} height={area.height} />)}
    </g>
    <g fill="none" stroke="#91a2a1" strokeOpacity=".6" strokeWidth="5" aria-hidden="true">{areas.map((area) => <rect key={area.id} x={area.x} y={area.y} width={area.width} height={area.height} />)}</g>
    {CORRIDORS.map((hall) => <rect key={hall.id} className="corridor-floor" style={{ stroke: "none" }} x={hall.x} y={hall.y} width={hall.width} height={hall.height} />)}
    {ROOMS.map((room) => <rect key={room.id} className={room.id === activeRoomId ? "room active" : "room"} style={{ stroke: "none", fill: ROOM_COLORS[room.id] }} x={room.x} y={room.y} width={room.width} height={room.height} />)}
    <rect width="1000" height="720" fill={`url(#${gridId})`} clipPath={`url(#${floorId})`} pointerEvents="none" />
    <ShipProps />
    {ROOMS.map((room) => <text key={room.id} className="room-label" x={room.x + 9} y={room.y + 17}>{room.label.toUpperCase()}</text>)}
    {VENTS.map((vent) => <g key={vent.id} className="vent-marker" transform={`translate(${vent.position.x} ${vent.position.y})`}><rect x="-11" y="-8" width="22" height="16" rx="3" /><path d="M-6 -3H6M-6 1H6M-6 5H6" /></g>)}
    <ShipTaskStations tasks={tasks} />
    {children}
  </svg>
}

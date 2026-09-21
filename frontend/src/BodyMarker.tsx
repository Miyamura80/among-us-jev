import type { CSSProperties } from "react"
import { Crewmate } from "./Crewmate"
import type { Color } from "./game"
import type { RemoteGame, RemotePlayer } from "./remote"

export function BodyMarker({ body, player, scale, currentTick }: {
  body: RemoteGame["bodies"][number]
  player: RemotePlayer
  scale: number
  currentTick: number
}) {
  const fresh = currentTick - body.createdAtTick <= 1
  const style: CSSProperties = {
    transform: `translate3d(${body.position.x * scale}px, ${body.position.y * scale}px, 0) translate(-50%, -50%)`,
  }
  return <div className={`map-entity body ${fresh ? "fresh" : ""}`} style={style} aria-label={`${player.name}'s body`}>
    {fresh && <div className="kill-burst" aria-hidden="true"><i /><i /></div>}
    <div className="corpse-sprite"><span className="corpse-shadow" /><Crewmate color={player.color as Color} dead small /></div>
  </div>
}

import { useEffect, useRef, useState } from "react"
import type { Color } from "./game"
import { Crewmate } from "./Crewmate"
import type { RemotePlayer } from "./remote"

export function MapPlayer({ player, scale, viewed, canSelect, onSelect }: {
  player: RemotePlayer & { position: { x: number; y: number } }
  scale: number
  viewed: boolean
  canSelect: boolean
  onSelect: () => void
}) {
  const { x, y } = player.position
  const last = useRef({ x, y })
  const [walking, setWalking] = useState(false)
  const [facingLeft, setFacingLeft] = useState(false)

  useEffect(() => {
    const dx = x - last.current.x
    const dy = y - last.current.y
    last.current = { x, y }
    if (Math.hypot(dx, dy) < 1) return
    if (Math.abs(dx) > 1) setFacingLeft(dx < 0)
    setWalking(true)
    const timer = window.setTimeout(() => setWalking(false), 310)
    return () => window.clearTimeout(timer)
  }, [x, y])

  return <button
    className={`map-entity player ${viewed ? "viewed" : ""} ${player.role === "impostor" ? "impostor" : ""} ${player.human ? "human" : ""} ${walking ? "walking" : ""} ${facingLeft ? "facing-left" : ""}`}
    style={{ transform: `translate3d(${player.position.x * scale}px, ${player.position.y * scale}px, 0) translate(-50%, -50%)` }}
    onClick={canSelect ? onSelect : undefined}
    aria-label={canSelect ? `View ${player.name}` : player.name}
  >
    <span>{player.name}</span>
    <Crewmate color={player.color as Color} small />
  </button>
}

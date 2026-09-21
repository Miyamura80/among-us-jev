import { useEffect, useRef } from "react"
import { visibilityBoundary } from "../../src/game/map"

interface Point { x: number; y: number }

function traceBoundary(context: CanvasRenderingContext2D, origin: Point, boundary: Point[]): void {
  context.beginPath()
  context.moveTo(origin.x, origin.y)
  for (const point of boundary) context.lineTo(point.x, point.y)
  context.closePath()
}

function drawFog(context: CanvasRenderingContext2D, origin: Point, radius: number): void {
    const boundary = visibilityBoundary(origin, radius)
    context.clearRect(0, 0, 1000, 720)
    context.fillStyle = "rgba(3, 9, 11, 0.91)"
    context.fillRect(0, 0, 1000, 720)

    context.save()
    traceBoundary(context, origin, boundary)
    context.clip()
    context.globalCompositeOperation = "destination-out"
    const glow = context.createRadialGradient(origin.x, origin.y, radius * 0.55, origin.x, origin.y, radius)
    glow.addColorStop(0, "rgba(0, 0, 0, 1)")
    glow.addColorStop(0.78, "rgba(0, 0, 0, 1)")
    glow.addColorStop(1, "rgba(0, 0, 0, 0)")
    context.fillStyle = glow
    context.fillRect(origin.x - radius, origin.y - radius, radius * 2, radius * 2)
    context.restore()

    // The full circle communicates range; the wall-clipped cutout above remains
    // the authoritative visible area.
    context.save()
    context.strokeStyle = "rgba(177, 255, 204, 0.64)"
    context.lineWidth = 1.5
    context.setLineDash([7, 5])
    context.beginPath()
    context.arc(origin.x, origin.y, radius, 0, Math.PI * 2)
    context.stroke()
    context.restore()
}

export function VisionFog({ origin, radius }: { origin: Point; radius: number }) {
  const { x, y } = origin
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displayed = useRef({ origin: { x, y }, radius })

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d")
    if (!context) return
    const start = displayed.current
    const target = { x, y }
    const changed = start.origin.x !== x || start.origin.y !== y || start.radius !== radius
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    if (!changed || reducedMotion) {
      displayed.current = { origin: target, radius }
      drawFog(context, target, radius)
      return
    }
    const began = performance.now()
    let frame = 0
    const animate = (now: number) => {
      const progress = Math.min(1, (now - began) / 220)
      const position = {
        x: start.origin.x + (x - start.origin.x) * progress,
        y: start.origin.y + (y - start.origin.y) * progress,
      }
      const currentRadius = start.radius + (radius - start.radius) * progress
      displayed.current = { origin: position, radius: currentRadius }
      drawFog(context, position, currentRadius)
      if (progress < 1) frame = window.requestAnimationFrame(animate)
    }
    animate(began)
    return () => window.cancelAnimationFrame(frame)
  }, [x, y, radius])

  return <canvas ref={canvasRef} className="vision-fog" width={1000} height={720} aria-hidden="true" />
}

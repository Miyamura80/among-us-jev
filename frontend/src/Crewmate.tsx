import type { Color } from "./game"

const COLORS: Record<Color, [string, string]> = {
  red: ["#e2474b", "#8d202d"], cyan: ["#35cbe8", "#16869f"], lime: ["#72d94e", "#3f8b30"], yellow: ["#f3c84b", "#a87a1d"], pink: ["#ee76ae", "#9f416e"], orange: ["#ee8736", "#a64a20"], white: ["#dedfd7", "#858881"], purple: ["#8e5ac8", "#4e2e78"], blue: ["#4169c1", "#203b83"], coral: ["#ef6d62", "#a83538"], mint: ["#76d8b1", "#408e78"], brown: ["#8c5e42", "#503526"], gray: ["#89939d", "#4e5964"], banana: ["#f4e28a", "#b1a14f"], rose: ["#cc6e83", "#803b50"],
}

export function Crewmate({ color, dead = false, small = false }: { color: Color; dead?: boolean; small?: boolean }) {
  const [main, shade] = COLORS[color]
  return <svg className={small ? "crew-svg small" : "crew-svg"} viewBox="0 0 52 60" aria-hidden="true">
    {dead ? <g className="corpse-art">
      <ellipse cx="27" cy="53" rx="20" ry="4" fill="#050908" opacity=".38" />
      <path d="M11 36h31v11c0 6-4 9-10 9H20c-6 0-9-4-9-9z" fill={main} stroke="#111723" strokeWidth="3" />
      <path d="M9 43H4v8c0 3 2 5 5 5h9" fill={shade} stroke="#111723" strokeWidth="3" />
      <path d="m17 37 5-7 5 6 5-7 6 8" fill="#7c1e2a" stroke="#111723" strokeLinejoin="round" strokeWidth="3" />
      <path d="M27 31V14" stroke="#eee5cf" strokeWidth="7" />
      <circle cx="23" cy="13" r="5" fill="#eee5cf" stroke="#111723" strokeWidth="2.5" />
      <circle cx="31" cy="13" r="5" fill="#eee5cf" stroke="#111723" strokeWidth="2.5" />
    </g> : <>
      <g className="crew-legs">
        <path className="crew-leg crew-leg-left" d="M15 39h11v14c0 3-2 5-5 5h-2c-3 0-4-2-4-5Z" fill={main} stroke="#111723" strokeWidth="3" />
        <path className="crew-leg crew-leg-right" d="M29 39h12v14c0 3-2 5-5 5h-2c-3 0-5-2-5-5Z" fill={shade} stroke="#111723" strokeWidth="3" />
      </g>
      <g className="crew-body">
        <path d="M12 19C12 8 19 3 30 3s17 7 17 18v19c0 5-4 8-9 8H17c-5 0-9-3-9-8V27c0-4 1-6 4-8Z" fill={main} stroke="#111723" strokeWidth="3.5" />
        <path d="M9 25H4v21c0 4 2 6 5 6h2" fill={shade} stroke="#111723" strokeWidth="3" />
        <path d="M25 10h14c7 0 10 4 9 9l-1 5c-1 4-4 6-8 6H25c-6 0-9-3-9-8s4-12 9-12Z" fill="#bce8ec" stroke="#111723" strokeWidth="3" />
        <path d="M25 13h12c4 0 6 2 6 4" fill="none" stroke="#efffff" strokeLinecap="round" strokeWidth="3" />
      </g>
    </>}
  </svg>
}

import type { ReactNode } from "react"

function Fixture({ x, y, children, rotate = 0 }: { x: number; y: number; children: ReactNode; rotate?: number }) {
  return <g className="ship-fixture" transform={`translate(${x} ${y}) rotate(${rotate})`}>{children}</g>
}

function Engine({ y }: { y: number }) {
  return <Fixture x={117} y={y}>
    <path d="M-22-38H22V38H-22Z" fill="#222e38" /><path d="M-29-27H-17M-29 0H-17M-29 27H-17M17-27H29M17 0H29M17 27H29" stroke="#86908a" strokeWidth="6" />
    <rect x="-20" y="-36" width="40" height="72" rx="18" fill="#9b5b51" /><rect x="-14" y="-24" width="28" height="48" rx="12" fill="#d48c67" />
    <path d="M-18-17H18M-18 0H18M-18 17H18" stroke="#4c4141" strokeWidth="5" /><path d="M-8-28H8M-8 29H8" stroke="#f1ba70" strokeWidth="3" />
    <path d="M-28-40V43H30" fill="none" stroke="#b99560" strokeWidth="3" />
  </Fixture>
}

function CafeteriaTable({ x, y, emergency = false }: { x: number; y: number; emergency?: boolean }) {
  return <Fixture x={x} y={y}>
    <ellipse cy="4" rx="28" ry="23" fill="#152a39" /><circle r="24" fill="#397692" /><circle r="19" fill="#4889a4" stroke="#8cbdc3" />
    <path d="M-29-10V10M29-10V10M-10 29H10M-10-29H10" stroke="#598da1" strokeWidth="5" />
    {emergency ? <><rect x="-10" y="-8" width="20" height="16" rx="3" fill="#bcbab0" /><circle r="5" fill="#e36261" stroke="#713d43" /><path d="M-7 11H7" stroke="#e1ca83" /></> : <><rect x="-10" y="-7" width="10" height="7" rx="1" fill="#c5bb91" /><circle cx="8" cy="5" r="4" fill="#d7d7c5" /></>}
  </Fixture>
}

export function ShipProps() {
  return <g className="ship-props" aria-hidden="true" pointerEvents="none">
    <CafeteriaTable x={412} y={112} /><CafeteriaTable x={586} y={112} /><CafeteriaTable x={500} y={158} emergency /><CafeteriaTable x={411} y={184} /><CafeteriaTable x={608} y={188} />
    <Engine y={166} /><Engine y={592} />
    <Fixture x={43} y={382}><rect x="-13" y="-29" width="26" height="58" rx="10" fill="#66557c" /><rect x="-7" y="-24" width="14" height="48" rx="7" fill="#80c3dc" /><path d="M-17-18H17M-17 0H17M-17 18H17" stroke="#454259" strokeWidth="6" /><path d="M-18-47H18M-18 47H18" stroke="#a999bb" strokeWidth="4" /></Fixture>
    {[278, 320].map((y) => <Fixture key={y} x={420} y={y}><rect x="-12" y="-13" width="23" height="27" rx="3" fill="#bbc8c7" /><rect x="-10" y="-5" width="19" height="17" rx="2" fill="#559daf" /><path d="M-7-8H7" stroke="#eff3dc" strokeWidth="5" /></Fixture>)}
    <Fixture x={317} y={277}><path d="M-7 0H7M0-7V7" stroke="#82cbeb" strokeWidth="4" /></Fixture>
    <Fixture x={240} y={333}><path d="M-29 13V-9H29V13" fill="#3e5354" /><path d="M-24-5H-10V6H-24ZM-7-5H7V6H-7ZM10-5H24V6H10Z" fill="#74b8a5" /><path d="M-22 17H22" stroke="#95a6a0" /><rect x="-8" y="22" width="16" height="14" rx="5" fill="#657e86" /></Fixture>
    <Fixture x={274} y={460}><rect x="-17" y="-10" width="34" height="28" rx="2" fill="#606875" /><path d="M-13-4H13M-13 2H13M-13 8H13" stroke="#252f3b" /><path d="M-12 19V28H-19M0 19V31H17" fill="none" stroke="#bc9b50" strokeWidth="2" /></Fixture>
    {[[438, 457, 34], [479, 447, 30], [449, 498, 35], [490, 489, 28], [552, 552, 25]].map(([x, y, size]) => <Fixture key={`${x}-${y}`} x={x!} y={y!}><rect width={size} height={size} rx="2" fill="#68826b" /><path d={`M3 3L${size! - 3} ${size! - 3}M${size! - 3} 3L3 ${size! - 3}`} stroke="#3b574e" strokeWidth="3" /><path d={`M1 2H${size! - 1}`} stroke="#abc09a" /></Fixture>)}
    <Fixture x={600} y={459}><ellipse rx="13" ry="6" cy="27" fill="#303a37" /><rect x="-11" y="-4" width="22" height="30" rx="5" fill="#a38155" /><ellipse rx="11" ry="5" cy="-4" fill="#c0a278" /><path d="M-11 6H11M-11 18H11" stroke="#665b48" strokeWidth="3" /></Fixture>
    <Fixture x={622} y={331}><rect x="-20" y="-15" width="40" height="34" rx="4" fill="#587767" /><rect x="-15" y="-10" width="30" height="21" fill="#214944" /><path d="M-12-3L-4 5L3-5L12 3M0-8V9" fill="none" stroke="#65b28a" /><path d="M-13 15H13" stroke="#a8c39c" /></Fixture>
    <Fixture x={753} y={304}><rect x="-17" y="-8" width="25" height="43" rx="11" fill="#6c9c93" /><ellipse cx="-4" cy="-8" rx="12" ry="5" fill="#a6c6b3" /><path d="M-15 4H7M-15 20H7" stroke="#3e655f" strokeWidth="4" /><path d="M8 20H20V-4H28" fill="none" stroke="#96ad94" strokeWidth="5" /></Fixture>
    <Fixture x={790} y={589}><circle r="26" fill="#596b7d" /><circle r="20" fill="#91c4ce" /><path d="M0-20V20M-18-10L18 10M-18 10L18-10" stroke="#405b72" strokeWidth="5" /><circle r="8" fill="#cce8d8" /></Fixture>
    <Fixture x={653} y={664}><rect x="-31" y="-13" width="63" height="26" rx="3" fill="#5b6462" /><rect x="-25" y="-8" width="23" height="16" rx="2" fill="#263e3b" /><path d="M-22 2L-18-3L-13 5L-8-4L-4 0" fill="none" stroke="#78b68e" /><circle cx="10" r="6" fill="#263638" /><circle cx="25" r="4" fill="#9caa95" /></Fixture>
    <Fixture x={960} y={362}><path d="M-17-25L9-15V15L-17 25Z" fill="#607f87" /><path d="M-12-18L4-10V10L-12 18Z" fill="#73b5ca" /><path d="M-10-8H1M-10 0H1M-10 8H1" stroke="#bbded8" /></Fixture>
    <Fixture x={812} y={99}><path d="M-18 5L7-13L25-13V-3L5-3L-11 14Z" fill="#8a9fa2" /><circle cy="14" r="18" fill="#627d81" /><circle cy="14" r="10" fill="#a8bbb2" /></Fixture>
    {[[278, 182], [152, 274], [520, 277], [838, 264]].map(([x, y]) => <Fixture key={`${x}-${y}`} x={x!} y={y!}><path d="M-7-5H5L9 0L5 5H-7Z" fill="#7e9290" /><circle cx="4" r="2" fill="#a5d6c1" /></Fixture>)}
  </g>
}

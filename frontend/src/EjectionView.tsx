import { Warning } from "@phosphor-icons/react"
import { Ballot } from "./MeetingView"
import { Crewmate } from "./Crewmate"
import type { Color } from "./game"
import type { RemoteGame } from "./remote"

export function EjectionView({ game }: { game: RemoteGame }) {
  const result = game.ejection
  if (!result) return null
  const ejected = game.players.find((player) => player.id === result.ejectedId)
  return <main className="ejection-screen">
    <div className="ejection-stars" aria-hidden="true" />
    {ejected ? <div className="ejected-crew"><Crewmate color={ejected.color as Color} /><span>{ejected.name}</span></div> : <div className="ejection-skip"><Warning weight="thin" /></div>}
    <section className="ejection-result"><span>VOTE COMPLETE</span><h1>{ejected ? `${ejected.name} was ejected.` : "No one was ejected."}</h1><p>{ejected ? "Their signal has left the ship." : "The vote ended in a tie or skip."}</p><details><summary>View complete ballot</summary><Ballot game={game} votes={result.votes} /></details></section>
  </main>
}

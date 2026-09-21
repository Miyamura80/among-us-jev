import { useState } from "react"
import { Brain, CaretDown, Check, Cpu, Eye, Gauge, Play, SlidersHorizontal, Users, WarningDiamond } from "@phosphor-icons/react"
import { Crewmate } from "./Crewmate"
import { ServerGameView } from "./ServerGameView"
import { DEFAULT_CONFIG, type GameConfig } from "./game"
import { createRemoteGame, type RemoteSession } from "./remote"

const MODELS = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", provider: "OpenRouter", latency: "Paid" },
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free)", provider: "OpenRouter", latency: "Free tier" },
  { id: "unbiased/pareto", label: "Pareto", provider: "OpenRouter", latency: "Verified" },
  { id: "stealth/union-alpha", label: "Union Alpha (currently 404)", provider: "OpenRouter", latency: "Unavailable" },
]

function App() {
  const [config, setConfig] = useState<GameConfig>(DEFAULT_CONFIG)
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState("")
  if (session) return <ServerGameView initialSession={session} onExit={() => setSession(null)} />

  const selected = MODELS.find((model) => model.id === config.system2Model) ?? { id: config.system2Model, label: "Custom model", provider: "OpenRouter", latency: "Unverified" }
  const update = <K extends keyof GameConfig>(key: K, value: GameConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const launch = async () => {
    setLaunching(true)
    setLaunchError("")
    try { setSession(await createRemoteGame(config)) } catch (caught) { setLaunchError(caught instanceof Error ? caught.message : "Could not reach the game server") } finally { setLaunching(false) }
  }

  return <main className="lobby-shell"><div className="stars" />
    <header className="lobby-nav"><div className="wordmark"><span className="signal-dot" /> MIRA/OS <em>SIMULATION 04</em></div><div className="nav-status"><span><i /> JEV ONLINE</span><b>BUILD 0.4.12</b></div></header>
    <section className="hero-copy"><div className="eyebrow"><span>DEEP SPACE SOCIAL SYSTEMS LAB</span><i /></div><h1>Trust is a<br /><em>finite resource.</em></h1><p>One ship. Two layers of machine cognition.<br />No one gets the whole picture.</p><div className="architecture-line"><div><Brain weight="fill" /><span><b>SYSTEM 2</b> strategic intent</span></div><i /><div><Cpu weight="fill" /><span><b>SYSTEM 1</b> Jev control</span></div><i /><div><Gauge weight="fill" /><span><b>255</b> fixed actions</span></div></div></section>
    <section className="setup-console"><div className="console-title"><div><span>MISSION CONTROL</span><h2>Configure the simulation</h2></div><span className="step-count">01 / 03</span></div>
      <div className="field-group"><label>PARTICIPATION</label><div className="mode-toggle"><button className={config.mode === "human" ? "active" : ""} onClick={() => update("mode", "human")}><span className="mode-icon"><Users weight="fill" /></span><span><b>Enter the ship</b><small>1 human · agents fill remaining seats</small></span>{config.mode === "human" && <Check weight="bold" />}</button><button className={config.mode === "agents" ? "active" : ""} onClick={() => update("mode", "agents")}><span className="mode-icon"><Eye weight="fill" /></span><span><b>Observer mode</b><small>Watch an entirely autonomous match</small></span>{config.mode === "agents" && <Check weight="bold" />}</button></div></div>
      <div className="split-fields"><div className="field-group"><label htmlFor="crew-size">CREW SIZE <b>{config.playerCount}</b></label><input id="crew-size" type="range" min="4" max="15" value={config.playerCount} onChange={(event) => update("playerCount", Number(event.target.value))} /><div className="range-labels"><span>4</span><span>15 agents</span></div></div><div className="field-group"><label htmlFor="impostors">IMPOSTORS</label><div className="segmented" id="impostors">{[1, 2, 3].map((value) => <button key={value} className={config.impostorCount === value ? "active" : ""} onClick={() => update("impostorCount", value)}>{value}</button>)}</div></div></div>
      <div className="field-group"><label htmlFor="model">SYSTEM 2 · PLANNING MODEL</label><div className="select-wrap"><Brain weight="fill" /><select id="model" value={config.system2Model} onChange={(event) => update("system2Model", event.target.value)}>{MODELS.map((model) => <option key={model.id} value={model.id}>{model.label} / {model.provider}</option>)}{!MODELS.some((model) => model.id === config.system2Model) && <option value={config.system2Model}>Custom · {config.system2Model}</option>}</select><CaretDown weight="bold" /></div><div className="model-meta"><span><i /> {selected.provider}</span><span>STATUS · {selected.latency}</span><span>APPLIED TO {config.mode === "human" ? config.playerCount - 1 : config.playerCount} AGENTS</span></div></div>
      <button className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}><SlidersHorizontal /><span>Advanced cognition settings</span><CaretDown className={advanced ? "rotated" : ""} /></button>
      {advanced && <div className="advanced-panel"><label>OpenRouter model ID<input value={config.system2Model} onChange={(event) => update("system2Model", event.target.value)} /></label><label>OpenAI-compatible endpoint<input value={config.system2Endpoint} onChange={(event) => update("system2Endpoint", event.target.value)} /></label></div>}
      <button className="launch-button" disabled={launching} onClick={() => void launch()}><span><Play weight="fill" /> {launching ? "Contacting server" : "Launch simulation"}</span><small>{config.mode === "human" ? "WASD · server authoritative" : "Private POV switching"}</small></button>
      <div className={`console-note ${launchError ? "error" : ""}`}><WarningDiamond weight="fill" /><span>{launchError || "Jev chooses only masked actions. System 2 plans and discusses through OpenRouter; provider failures fall back locally."}</span></div>
    </section>
    <div className="floating-crew crew-one"><Crewmate color="cyan" /></div><div className="floating-crew crew-two"><Crewmate color="red" /></div>
    <footer className="lobby-footer"><span>AMONG US–INSPIRED AUTONOMOUS AGENT RESEARCH SIMULATOR</span><span>← → OBSERVE ANY ACTIVE UNIT</span></footer>
  </main>
}

export default App

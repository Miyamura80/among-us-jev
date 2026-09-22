import { useState } from "react"
import { Brain, CaretDown, Check, Cpu, Eye, Gauge, Play, SlidersHorizontal, Users, WarningDiamond } from "@phosphor-icons/react"
import { Crewmate } from "./Crewmate"
import { ServerGameView } from "./ServerGameView"
import { DEFAULT_CONFIG, type GameConfig } from "./game"
import { createRemoteGame, type RemoteSession } from "./remote"

const MODELS = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free)" },
  { id: "unbiased/pareto", label: "Pareto" },
]

function App() {
  const [config, setConfig] = useState<GameConfig>(DEFAULT_CONFIG)
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [step, setStep] = useState<"access" | "setup">("access")
  const [openRouterApiKey, setOpenRouterApiKey] = useState("")
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState("")

  const update = <K extends keyof GameConfig>(key: K, value: GameConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const continueAccess = () => {
    if (!openRouterApiKey.trim()) return
    setLaunchError("")
    setStep("setup")
  }
  const launch = async () => {
    setLaunching(true)
    setLaunchError("")
    try {
      setSession(await createRemoteGame(config, openRouterApiKey.trim()))
    } catch (caught) {
      setLaunchError(caught instanceof Error ? caught.message : "Could not reach the game server")
    } finally { setLaunching(false) }
  }

  if (session) return <ServerGameView initialSession={session} onExit={() => setSession(null)} />

  return <main className="lobby-shell"><div className="stars" />
    <header className="lobby-nav"><div className="wordmark"><span className="signal-dot" /> Jev Among Us</div><div className="nav-status"><span><i /> JEV ONLINE</span></div></header>
    <section className="hero-copy"><div className="eyebrow"><span>DEEP SPACE SOCIAL SYSTEMS LAB</span><i /></div><h1>Jev<br /><em>Among Us</em></h1><p>One ship. Two layers of machine cognition.<br />No one gets the whole picture.</p><div className="architecture-line"><div><Brain weight="fill" /><span><b>SYSTEM 2</b> strategic intent</span></div><i /><div><Cpu weight="fill" /><span><b>SYSTEM 1</b> Jev control</span></div><i /><div><Gauge weight="fill" /><span><b>255</b> fixed actions</span></div></div></section>
    <section className="setup-console">
      <div className="console-title"><div><span>MISSION CONTROL</span><h2>{step === "access" ? "Connect OpenRouter" : "Choose your role"}</h2></div><span className="step-count">{step === "access" ? "01 / 02" : "02 / 02"}</span></div>
      {step === "access" ? <>
        <div className="field-group">
          <label className="key-field" htmlFor="openrouter-key">OPENROUTER API KEY<input id="openrouter-key" type="password" autoComplete="off" spellCheck={false} value={openRouterApiKey} onChange={(event) => setOpenRouterApiKey(event.target.value)} placeholder="sk-or-…" /><small>Get a key at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">OpenRouter</a>.</small></label>
        </div>
        <button className="launch-button" disabled={!openRouterApiKey.trim()} onClick={continueAccess}><span><Play weight="fill" /> Continue</span></button>
      </> : <>
        <button className="step-back" type="button" onClick={() => setStep("access")}>← Change key</button>
        <div className="field-group"><span className="field-heading">PARTICIPATION</span><div className="mode-toggle"><button type="button" className={config.mode === "human" ? "active" : ""} aria-pressed={config.mode === "human"} onClick={() => update("mode", "human")}><span className="mode-icon"><Users weight="fill" /></span><span><b>Enter the ship</b><small>Play alongside the agents</small></span>{config.mode === "human" && <Check weight="bold" />}</button><button type="button" className={config.mode === "agents" ? "active" : ""} aria-pressed={config.mode === "agents"} onClick={() => update("mode", "agents")}><span className="mode-icon"><Eye weight="fill" /></span><span><b>Observer mode</b><small>Watch an autonomous match</small></span>{config.mode === "agents" && <Check weight="bold" />}</button></div></div>
        <details className="setup-details"><summary className="advanced-toggle"><SlidersHorizontal /><span>Customize game settings</span><CaretDown /></summary><div className="advanced-panel">
          <div className="split-fields"><div className="field-group"><label htmlFor="crew-size">CREW SIZE <b>{config.playerCount}</b></label><input id="crew-size" type="range" min="4" max="15" value={config.playerCount} onChange={(event) => update("playerCount", Number(event.target.value))} /><div className="range-labels"><span>4</span><span>15 players</span></div></div><div className="field-group"><label htmlFor="impostors">IMPOSTORS</label><div className="segmented" id="impostors">{[1, 2, 3].map((value) => <button type="button" key={value} className={config.impostorCount === value ? "active" : ""} onClick={() => update("impostorCount", value)}>{value}</button>)}</div></div></div>
          <div className="field-group"><label htmlFor="model">PLANNING MODEL</label><div className="select-wrap"><Brain weight="fill" /><select id="model" value={config.system2Model} onChange={(event) => update("system2Model", event.target.value)}>{MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}{!MODELS.some((model) => model.id === config.system2Model) && <option value={config.system2Model}>{config.system2Model}</option>}</select><CaretDown weight="bold" /></div></div>
        </div></details>
        <button className="launch-button" disabled={launching} onClick={() => void launch()}><span><Play weight="fill" /> {launching ? "Contacting server" : config.mode === "human" ? "Enter the ship" : "Start observing"}</span></button>
      </>}
      {launchError && <div className="console-note error" role="alert"><WarningDiamond weight="fill" /><span>{launchError}</span></div>}
    </section>
    <div className="floating-crew crew-one"><Crewmate color="cyan" /></div><div className="floating-crew crew-two"><Crewmate color="red" /></div>
    <footer className="lobby-footer"><span>AMONG US–INSPIRED AUTONOMOUS AGENT RESEARCH SIMULATOR</span><span>← → OBSERVE ANY ACTIVE UNIT</span></footer>
  </main>
}

export default App

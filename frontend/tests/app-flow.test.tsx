import { expect, test } from "bun:test"
import { Window } from "happy-dom"

const testWindow = new Window({ url: "http://localhost" })
Object.assign(testWindow, { SyntaxError })
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
  Event: testWindow.Event,
  MutationObserver: testWindow.MutationObserver,
})

const { render, fireEvent, cleanup } = await import("@testing-library/react")
const { default: App } = await import("../src/App")
const findButton = (container: HTMLElement, label: string) => [...container.getElementsByTagName("button")].find((button) => button.textContent?.toLowerCase().includes(label))

test("OpenRouter key leads to the role selector before game settings", () => {
  try {
    const view = render(<App />)
    expect(view.container.textContent).not.toContain("Watch an ad")
    expect(findButton(view.container, "observer mode")).toBeUndefined()

    expect(findButton(view.container, "continue")?.disabled).toBe(true)
    fireEvent.change(testWindow.document.getElementById("openrouter-key")!, { target: { value: "sk-or-test" } })
    expect(findButton(view.container, "continue")?.disabled).toBe(false)
    fireEvent.click(findButton(view.container, "continue")!)

    expect(findButton(view.container, "enter the ship")).toBeDefined()
    expect(findButton(view.container, "observer mode")).toBeDefined()
    expect(view.container.getElementsByTagName("details")[0]?.open).toBe(false)
    fireEvent.click(findButton(view.container, "observer mode")!)
    expect(findButton(view.container, "start observing")).toBeDefined()
    fireEvent.click(view.container.getElementsByTagName("summary")[0]!)
    expect(view.container.getElementsByTagName("details")[0]?.open).toBe(true)
  } finally { cleanup() }
})

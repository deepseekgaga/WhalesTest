export function element({
  text = "",
  value = "",
  disabled = false,
  checked = false,
  href = "",
  children = [],
  width = 50,
  height = 20,
  display = "block",
  visibility = "visible",
} = {}) {
  return {
    textContent: text,
    value,
    disabled,
    checked,
    href,
    children,
    clicked: 0,
    events: [],
    style: { display, visibility },
    getAttribute(name) { return name === "aria-disabled" ? (this.disabled ? "true" : "false") : null; },
    getBoundingClientRect() { return { width, height, top: 0, left: 0 }; },
    scrollIntoView() {},
    dispatchEvent(event) { this.events.push(event.type); return true; },
    click() { this.clicked += 1; this.checked = true; },
    querySelectorAll(selector) { return selector === "input[type='checkbox']" ? children : []; },
  };
}

export function environment({ one = {}, many = {} } = {}) {
  return {
    document: {
      readyState: "complete",
      documentElement: {},
      querySelector(selector) { return one[selector] ?? null; },
      querySelectorAll(selector) { return many[selector] ?? []; },
      defaultView: { getComputedStyle: (node) => node?.style ?? { display: "block", visibility: "visible" } },
    },
    Event: class { constructor(type) { this.type = type; } },
    PointerEvent: class { constructor(type) { this.type = type; } },
    now: () => 0,
    sleep: async () => {},
    waitForQuiet: async () => {},
  };
}

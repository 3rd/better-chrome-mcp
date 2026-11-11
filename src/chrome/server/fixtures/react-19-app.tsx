/// <reference lib="dom" />

import React, { useState } from "react";
import { createRoot } from "react-dom/client";

let mountedRoot: ReturnType<typeof createRoot> | undefined;

const Counter = ({ id, initialCount }: Readonly<{ id: string; initialCount: number }>) => {
  const [count, setCount] = useState(initialCount);
  return (
    <button id={id} onClick={() => setCount((value) => value + 1)}>
      count:{count}
    </button>
  );
};

const MutationValues = ({
  items,
  active,
}: Readonly<{ items: { details: { label: string } }[]; active: boolean }>) => {
  const [record] = useState({ details: { label: "hook" } });
  return (
    <section>
      <output id="react-items">{JSON.stringify(items)}</output>
      <output id="react-hook-value">{JSON.stringify(record)}</output>
      {active ?
        <span id="react-indicator">Active</span>
      : null}
    </section>
  );
};

const MutationContext = React.createContext({ details: { label: "context" } });

class ClassValues extends React.Component<{ record: { details: { label: string } } }> {
  static override contextType = MutationContext;
  declare context: React.ContextType<typeof MutationContext>;
  override state = { record: { details: { label: "state" } } };

  override render() {
    return (
      <section>
        <output id="react-class-props">{JSON.stringify(this.props.record)}</output>
        <output id="react-class-state">{JSON.stringify(this.state.record)}</output>
        <output id="react-context">{JSON.stringify(this.context)}</output>
      </section>
    );
  }
}

const unmount = () => {
  if (!mountedRoot) throw new Error("React fixture root is not mounted");
  mountedRoot.unmount();
};

const App = () => {
  const [showSecondary, setShowSecondary] = useState(true);
  return (
    <main>
      <h1>React 19 fixture</h1>
      <Counter id="react-counter" initialCount={1} />
      <MutationValues items={[{ details: { label: "baseline" } }]} active={false} />
      <ClassValues record={{ details: { label: "class" } }} />
      {showSecondary ?
        <Counter id="react-counter-secondary" initialCount={10} />
      : null}
      <button id="react-hide-secondary" onClick={() => setShowSecondary(false)}>
        hide secondary
      </button>
      <button id="react-show-secondary" onClick={() => setShowSecondary(true)}>
        show secondary
      </button>
      <button id="react-unmount" onClick={unmount}>
        unmount
      </button>
    </main>
  );
};

const mount = () => {
  const root = document.getElementById("root");
  if (!root) return;
  mountedRoot = createRoot(root);
  mountedRoot.render(<App />);
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
else mount();

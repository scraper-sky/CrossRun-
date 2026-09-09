"use dom";
// The whole game runs in here, in a web view. Storage is provided by the
// native side as async props so saves live in the app's own storage.
import "./setup";
import React, { useMemo } from "react";
import CrossRun from "./crossrun.jsx";

// Shows a crash on screen instead of a blank page, so a failure is diagnosable on a phone.
class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 20, fontFamily: "monospace", fontSize: 12, color: "#fff", background: "#7a1f1f", whiteSpace: "pre-wrap" }}>
          CrossRun hit an error:{"\n"}{String(this.state.err && (this.state.err.stack || this.state.err))}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function CrossRunDom({ storageGet, storageSet, haptic }) {
  useMemo(() => {
    window.CROSSRUN_HAPTIC = haptic;
    window.storage = {
      get: async (key) => {
        const value = await storageGet(key);
        return value == null ? null : { value };
      },
      set: async (key, value) => storageSet(key, String(value)),
    };
  }, [storageGet, storageSet, haptic]);
  return <Catch><CrossRun /></Catch>;
}

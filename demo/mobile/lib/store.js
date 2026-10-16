// A minimal zustand-style store for Preact: create(init) returns a hook,
// useStore(selector), that also carries getState, setState and subscribe.
// A component re-renders only when its selected value changes (Object.is).
import { useEffect, useReducer, useRef } from "../vendor/preact-htm.js";

const identity = (s) => s;

export function create(init) {
  let state;
  const subs = new Set();
  const setState = (partial, replace) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    if (Object.is(next, state)) return;
    const prev = state;
    state = replace ? next : Object.assign({}, state, next);
    subs.forEach((l) => l(state, prev));
  };
  const getState = () => state;
  const subscribe = (l) => { subs.add(l); return () => subs.delete(l); };
  state = init(setState, getState, { setState, getState, subscribe });

  function useStore(selector = identity) {
    const [, force] = useReducer((c) => c + 1, 0);
    const sel = useRef(selector);
    sel.current = selector;
    const value = selector(state);
    const seen = useRef(value);
    seen.current = value;
    useEffect(() => {
      const check = (s) => { if (!Object.is(sel.current(s), seen.current)) force(); };
      const off = subscribe(check);
      // A change between render and subscribe would otherwise be missed.
      check(state);
      return off;
    }, []);
    return value;
  }
  return Object.assign(useStore, { setState, getState, subscribe });
}

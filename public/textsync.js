// Keeps one shared text identical for everyone in a room, even while several people type at once.
//
// Every change is a single replacement: "swap characters from..to with insert". The server puts all
// changes in one order. A change made against an older version is moved past the changes that landed
// first, and is refused if it touches the same characters as one of them. Each person's page replays
// the server's changes in order, so it always matches the server, and layers its own unsent typing on top.
//
// This file runs in both the browser and the server, so both sides apply exactly the same rules.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TextSync = factory();
})(this, function () {
  'use strict';

  const apply = (text, op) => text.slice(0, op.from) + op.insert + text.slice(op.to);

  // The smallest single replacement that turns `before` into `after`, or null if they are equal.
  function diff(before, after) {
    if (before === after) return null;
    const limit = Math.min(before.length, after.length);
    let start = 0;
    while (start < limit && before[start] === after[start]) start += 1;
    let end = 0;
    while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
    return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
  }

  // Moves `op` to where it should land after another change (from..to replaced by `inserted` characters)
  // has already happened. Returns null when the two changes touch the same characters.
  function transform(op, from, to, inserted) {
    if (op.to <= from) return op; // Entirely before it. Two inserts at one spot also come out here.
    if (op.from < to) return null;
    const shift = inserted - (to - from);
    return { ...op, from: op.from + shift, to: op.to + shift };
  }

  // The server's copy of the text and the recent changes made to it.
  class Doc {
    constructor(maxChars, logSize = 200) {
      this.maxChars = maxChars;
      this.logSize = logSize;
      this.text = '';
      this.version = 0;
      this.log = []; // Only positions and sizes are kept, which is all that moving later changes needs.
    }

    // Applies a change made against version `op.base`. Returns it as applied, or null if it is refused.
    accept(op) {
      const behind = this.version - op.base;
      if (behind < 0 || behind > this.log.length) return null;

      let moved = { from: op.from, to: op.to, insert: op.insert };
      for (const earlier of this.log.slice(this.log.length - behind)) {
        moved = transform(moved, earlier.from, earlier.to, earlier.inserted);
        if (!moved) return null;
      }
      if (moved.to > this.text.length) return null;
      if (this.text.length - (moved.to - moved.from) + moved.insert.length > this.maxChars) return null;

      this.text = apply(this.text, moved);
      this.version += 1;
      this.log.push({ from: moved.from, to: moved.to, inserted: moved.insert.length });
      if (this.log.length > this.logSize) this.log.shift();
      return moved;
    }
  }

  // One person's page. Feed it what the person types and what the server says; it says what to show and send.
  class Session {
    constructor() {
      this.text = ''; // The server's text as of `version`.
      this.version = 0;
      this.value = ''; // What the person sees: `text` plus their changes the server has not confirmed yet.
      this.inflight = null; // The one change sent and not yet answered. Only one goes out at a time.
      this.dropped = false; // Set when the person's unsent changes were discarded but `inflight` may still land.
      this.prefix = Math.random().toString(36).slice(2, 10);
      this.counter = 0;
    }

    // The person changed the text. Returns a change to send now, if there is one.
    edit(value) {
      this.value = value;
      return this.flush();
    }

    flush() {
      if (this.inflight) return null;
      const change = diff(this.text, this.value);
      if (!change) return null;
      this.counter += 1;
      this.dropped = false;
      this.inflight = { id: `${this.prefix}${this.counter}`, base: this.version, ...change };
      return this.inflight;
    }

    // The server accepted a change, ours or someone else's. Returns { value, send }:
    // `value` is the new text to show (null if what is shown is already right), `send` the next change to send.
    receive(op) {
      const ours = this.inflight?.id === op.id;
      const unsent = diff(this.text, this.value);
      this.text = apply(this.text, op);
      this.version = op.v;

      if (ours) {
        const wasDropped = this.dropped;
        this.inflight = null;
        this.dropped = false;
        if (!wasDropped) return { value: null, send: this.flush() }; // What is shown already includes it.
      }

      let shown = this.text;
      if (unsent) {
        const moved = transform(unsent, op.from, op.to, op.insert.length);
        if (moved) shown = apply(this.text, moved);
        else if (this.inflight) this.dropped = true;
      }
      this.value = shown;
      return { value: shown, send: this.flush() };
    }

    // The server refused our change because it collided with someone else's. Returns the text to show.
    reject(id) {
      if (this.inflight?.id !== id) return null;
      this.inflight = null;
      this.dropped = false;
      this.value = this.text;
      return this.value;
    }

    // A fresh copy from the server, on joining and after every reconnect.
    init(text, version) {
      // Typing done while disconnected survives if nothing changed on the server in the meantime.
      const keep = this.value !== this.text && version === this.version && text === this.text;
      this.inflight = null;
      this.dropped = false;
      this.text = text;
      this.version = version;
      if (keep) return { value: null, send: this.flush() };
      this.value = text;
      return { value: text, send: null };
    }
  }

  return { apply, diff, transform, Doc, Session };
});

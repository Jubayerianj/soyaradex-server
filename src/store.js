// src/store.js
//
// The record of trades the server holds: one JSON file, written atomically.
// One process owns it, and every operation is synchronous, so two can never
// interleave.
//
// Nothing here authorises anything. An entry is a receipt, the order and its
// route. AgentExecutor still refuses it unless GenLayer consensus recorded a
// verdict for exactly that order.

import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL_STAGES = new Set(['settled', 'expired', 'cancelled']);
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
const MAX_FINISHED = 500;

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export function createStore(file) {
  function readAll() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v : [];
    } catch {
      // Never overwrite a record we cannot read: set it aside and start clean.
      const aside = `${file}.unreadable-${Date.now()}`;
      fs.renameSync(file, aside);
      console.warn(`[store] ${file} was not valid JSON; kept it as ${aside}`);
      return [];
    }
  }

  function writeAll(list) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, file); // a crash mid-write never leaves half a file
  }

  // Open trades are always kept: each ends by its own deadline. Finished ones
  // go after a day, and at most MAX_FINISHED are kept.
  function prune(list, now) {
    const open = list.filter((e) => !TERMINAL_STAGES.has(e.stage));
    const done = list
      .filter((e) => TERMINAL_STAGES.has(e.stage) && now - (e.updatedAt || 0) <= KEEP_FINISHED_MS)
      .slice(0, MAX_FINISHED);
    return [...open, ...done].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  const store = {
    /** Can the record be written? The error when it cannot, else null. */
    probe() {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const p = `${file}.probe`;
        fs.writeFileSync(p, 'ok');
        fs.unlinkSync(p);
        return null;
      } catch (err) {
        return err?.message || String(err);
      }
    },

    list: () => readAll(),
    get: (commitment) => readAll().find((e) => same(e.commitment, commitment)) || null,
    findByRound: (txHash) => readAll().find((e) => same(e.validationTxHash, txHash)) || null,

    /** Hold a trade. Handing the same one over again refreshes it, but never revives a finished one. */
    register(entry, now = Date.now()) {
      if (!entry?.commitment || !entry.order || !entry.program) return null;
      const all = readAll();
      const prev = all.find((e) => same(e.commitment, entry.commitment));
      if (prev && TERMINAL_STAGES.has(prev.stage)) return prev;
      const next = { stage: 'waiting', attempts: 0, createdAt: now, ...prev, ...entry, updatedAt: now };
      writeAll(prune([next, ...all.filter((e) => !same(e.commitment, entry.commitment))], now));
      return next;
    },

    update(commitment, patch, now = Date.now()) {
      const all = readAll();
      let found = null;
      const next = all.map((e) => {
        if (!same(e.commitment, commitment)) return e;
        found = { ...e, ...patch, updatedAt: now };
        return found;
      });
      if (found) writeAll(prune(next, now));
      return found;
    },

    /** The user let the trade go: never settle it behind their back. */
    cancel(commitment, now = Date.now()) {
      const e = store.get(commitment);
      if (!e || TERMINAL_STAGES.has(e.stage)) return e;
      return store.update(commitment, { stage: 'cancelled' }, now);
    },
  };
  return store;
}

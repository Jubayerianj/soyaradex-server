// src/log.js
//
// Timestamped log lines. Railway stamps its own, but a local run has only
// these, and a gap nobody can date cannot be explained.

const stamp = () => new Date().toISOString();

export const log = {
  log: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), ...args),
  error: (...args) => console.error(stamp(), ...args),
};

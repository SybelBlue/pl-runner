import type { Logger } from "./types.js";

const colors = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
};

function prefix(color: string): string {
  return `${color}prairielearn:${colors.reset}`;
}

export function createLogger(quiet = false): Logger {
  const enabled = !quiet;
  return {
    error(message) {
      if (enabled) console.error(`${prefix(colors.red)} ${message}`);
    },
    warn(message) {
      if (enabled) console.warn(`${prefix(colors.yellow)} ${message}`);
    },
    info(message) {
      if (enabled) console.log(`${prefix(colors.green)} ${message}`);
    },
    debug(message) {
      if (enabled) console.error(`${prefix(colors.gray)} ${message}`);
    },
  };
}

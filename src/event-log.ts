import fs from "node:fs/promises";
import path from "node:path";
import type { LogSource, Logger, RunEvent } from "./types.js";

const MAX_RUN_LOG_BYTES = 10 * 1024 * 1024;
const MEMORY_TAIL_ENTRIES = 1_000;

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export class EventLog {
  private seq = 0;
  private tail: RunEvent[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private outputFilter = new OutputFilter();

  constructor(
    private readonly file: string,
    private readonly runId: string,
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const existing = await readEvents(this.file);
    this.seq = existing.at(-1)?.seq ?? 0;
    this.tail = existing.filter((event) => this.outputFilter.keep(event)).slice(-MEMORY_TAIL_ENTRIES);
  }

  append(source: LogSource, phase: string, rawMessage: string): Promise<void> {
    const messages = sanitizeTerminalText(rawMessage).split(/\r?\n/).filter((line) => line.length > 0);
    if (messages.length === 0) return this.writeQueue;

    this.writeQueue = this.writeQueue.then(async () => {
      const lines: string[] = [];
      for (const message of messages) {
        const event: RunEvent = {
          seq: this.seq + 1,
          timestamp: new Date().toISOString(),
          source,
          phase,
          message,
        };
        if (!this.outputFilter.keep(event)) continue;
        this.seq += 1;
        this.tail.push(event);
        lines.push(JSON.stringify(event));
      }
      if (lines.length === 0) return;
      this.tail = this.tail.slice(-MEMORY_TAIL_ENTRIES);
      await fs.appendFile(this.file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      await capEventLog(this.file);
    });
    return this.writeQueue;
  }

  recent(limit = 200, afterSeq = 0): RunEvent[] {
    return this.tail.filter((event) => event.seq > afterSeq).slice(-limit);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

export function eventLogger(log: EventLog, phase: () => string): Logger {
  return {
    error(message) {
      void log.append("system", phase(), `error: ${message}`);
    },
    warn(message) {
      void log.append("system", phase(), `warning: ${message}`);
    },
    info(message) {
      void log.append("system", phase(), message);
    },
  };
}

export function omitDependencyPackageChanges(events: RunEvent[]): RunEvent[] {
  const filter = new OutputFilter();
  return events.filter((event) => filter.keep(event));
}

class OutputFilter {
  private uvOutput: "normal" | "installed" | "package-changes" = "normal";

  keep(event: Pick<RunEvent, "source" | "phase" | "message">): boolean {
    if (event.phase !== "dependencies" || event.source !== "stderr") {
      this.uvOutput = "normal";
      return true;
    }

    if (/^\s*(?:Installed|Uninstalled)\s+\d+\s+packages?\s+in\b/.test(event.message)) {
      this.uvOutput = "installed";
      return true;
    }
    if (this.uvOutput === "installed" && /^\s*Bytecode compiled\s+\d+\s+files?\s+in\b/.test(event.message)) {
      return true;
    }
    if (this.uvOutput === "installed" && /^\s*$/.test(event.message)) return false;
    if (this.uvOutput === "installed" && /^\s*[+-](?:\s|$)/.test(event.message)) {
      this.uvOutput = "package-changes";
      return false;
    }
    if (this.uvOutput === "package-changes") return false;

    this.uvOutput = "normal";
    return true;
  }
}

export async function readEvents(file: string, limit = MEMORY_TAIL_ENTRIES, afterSeq = 0): Promise<RunEvent[]> {
  try {
    const contents = await fs.readFile(file, "utf8");
    const events: RunEvent[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as RunEvent;
        if (typeof event.seq === "number" && event.seq > afterSeq) events.push(event);
      } catch {
        // Ignore a partial final line while another process is appending.
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

async function capEventLog(file: string): Promise<void> {
  const stat = await fs.stat(file);
  if (stat.size <= MAX_RUN_LOG_BYTES) return;
  const contents = await fs.readFile(file);
  const keepBytes = Math.floor(MAX_RUN_LOG_BYTES * 0.75);
  const start = Math.max(0, contents.length - keepBytes);
  const newline = contents.indexOf(0x0a, start);
  const kept = contents.subarray(newline === -1 ? start : newline + 1);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, kept, { mode: 0o600 });
  await fs.rename(temporary, file);
}

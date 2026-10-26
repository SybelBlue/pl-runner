import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";

const enableMouseTracking = "\u001B[?1000h\u001B[?1006h";
const disableMouseTracking = "\u001B[?1006l\u001B[?1000l";
const sgrMousePattern = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/gu;

export type MouseWheelEvent = {
  direction: "up" | "down";
  x: number;
  y: number;
};

export type MouseRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function createMouseWheelParser(): {
  push: (chunk: string | Uint8Array) => MouseWheelEvent[];
  reset: () => void;
} {
  let pending = "";

  return {
    push(chunk) {
      pending +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const events: MouseWheelEvent[] = [];
      let match: RegExpExecArray | null;
      let consumedThrough = 0;

      sgrMousePattern.lastIndex = 0;
      while ((match = sgrMousePattern.exec(pending)) !== null) {
        consumedThrough = match.index + match[0].length;
        const button = Number(match[1]);
        const wheelDirection = button & 3;
        const isWheel = (button & 64) !== 0;
        const isPress = match[4] === "M";
        if (
          isWheel &&
          isPress &&
          (wheelDirection === 0 || wheelDirection === 1)
        ) {
          events.push({
            direction: wheelDirection === 0 ? "up" : "down",
            x: Number(match[2]),
            y: Number(match[3]),
          });
        }
      }

      pending = possibleMousePrefix(pending.slice(consumedThrough));
      return events;
    },
    reset() {
      pending = "";
    },
  };
}

export function mouseEventIsInside(
  event: MouseWheelEvent,
  region: MouseRegion,
): boolean {
  // Terminal mouse coordinates are one-based; Ink layout coordinates are zero-based.
  return (
    event.x >= region.left + 1 &&
    event.x <= region.left + region.width &&
    event.y >= region.top + 1 &&
    event.y <= region.top + region.height
  );
}

export function useMouseWheel(
  onWheel: (event: MouseWheelEvent) => void,
  options: { isActive?: boolean } = {},
): void {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;

  useEffect(() => {
    const inputIsTty = "isTTY" in stdin && Boolean(stdin.isTTY);
    const outputIsTty = "isTTY" in stdout && Boolean(stdout.isTTY);
    if (options.isActive === false || !inputIsTty || !outputIsTty) return;

    const parser = createMouseWheelParser();
    const handleData = (chunk: unknown) => {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
      for (const event of parser.push(chunk)) onWheelRef.current(event);
    };

    stdout.write(enableMouseTracking);
    stdin.on("data", handleData);
    return () => {
      stdin.removeListener("data", handleData);
      parser.reset();
      stdout.write(disableMouseTracking);
    };
  }, [stdin, stdout, options.isActive]);
}

function possibleMousePrefix(input: string): string {
  const escapeIndex = input.lastIndexOf("\u001B");
  if (escapeIndex === -1) return "";
  const suffix = input.slice(escapeIndex);
  if ("\u001B[<".startsWith(suffix)) return suffix;
  return /^\u001B\[<\d*(?:;\d*){0,2}$/u.test(suffix) ? suffix : "";
}

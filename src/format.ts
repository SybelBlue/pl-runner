export function stripOsc11(input: string): string {
  return input.replace(/\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

export function formatRelativeTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 45) return "just now";

  const units: Array<[string, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  for (const [name, size] of units) {
    if (value >= size) {
      const amount = Math.floor(value / size);
      return `${amount} ${name}${amount === 1 ? "" : "s"} ago`;
    }
  }

  return "just now";
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function boldBright(value: string): string {
  return `\x1b[1;97m${value}\x1b[0m`;
}

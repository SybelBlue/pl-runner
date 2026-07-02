import { commitAgeSeconds, git, revision, upstreamRef } from "./git.js";
import { formatRelativeTime } from "./format.js";
import type { Logger } from "./types.js";

export type WatchHandle = {
  stop: () => void;
  didRestart: () => boolean;
};

export async function startUpstreamWatch(
  cwd: string,
  logger: Logger,
  terminate: (signal?: NodeJS.Signals) => void,
  intervalMs = 30_000,
): Promise<WatchHandle | null> {
  const upstream = await upstreamRef(cwd);
  if (!upstream) {
    logger.warn("upstream watch disabled: current branch has no configured upstream.");
    return null;
  }

  const age = await commitAgeSeconds(cwd, upstream.tracking);
  logger.info(
    age === null
      ? `watching upstream ${upstream.tracking}`
      : `watching upstream ${upstream.tracking} (${formatRelativeTime(age)})`,
  );

  let stopped = false;
  let restart = false;
  let lastRevision = await revision(cwd, upstream.tracking);

  const timer = setInterval(async () => {
    if (stopped) return;
    await git(cwd, ["fetch", upstream.remote, upstream.merge]);
    const upstreamRevision = await revision(cwd, upstream.tracking);
    if (!upstreamRevision || upstreamRevision === lastRevision) return;
    lastRevision = upstreamRevision;
    logger.info(`upstream revision changed: ${upstream.tracking}`);
    const head = await revision(cwd, "HEAD");
    if (head && head !== upstreamRevision) {
      logger.info("upstream changed; restarting");
      restart = true;
      terminate("SIGTERM");
    }
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    didRestart() {
      return restart;
    },
  };
}

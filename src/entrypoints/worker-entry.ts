import { recordWorkerStartupFailure, runWorker } from "../worker/worker.js";

const requestPath = process.argv[2];
if (!requestPath) {
  console.error("worker request path is required");
  process.exitCode = 2;
} else {
  runWorker(requestPath).then(
    (status) => {
      process.exitCode = status;
    },
    async (error) => {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      try {
        await recordWorkerStartupFailure(requestPath, error);
      } catch (recordError) {
        const recordMessage =
          recordError instanceof Error
            ? (recordError.stack ?? recordError.message)
            : String(recordError);
        console.error(
          `${message}\nUnable to record worker failure: ${recordMessage}`,
        );
      }
      process.exitCode = 1;
    },
  );
}

import { runWorker } from "./worker.js";

const requestPath = process.argv[2];
if (!requestPath) {
  console.error("worker request path is required");
  process.exitCode = 2;
} else {
  runWorker(requestPath).then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

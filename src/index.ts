import { main } from "./cli.js";

main().then(
  (status) => {
    process.exitCode = status;
  },
  (error) => {
    console.error(`prairielearn: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);

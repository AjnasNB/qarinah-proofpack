import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const child = spawn(process.execPath, [nextCli, "build"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production"
  },
  stdio: "inherit"
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Next.js build stopped by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

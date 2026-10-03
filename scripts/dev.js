// `npm run dev`: starts the Vite dev server and opens the Electron app on it.
import { spawn } from "node:child_process";
import electron from "electron";
import { createServer } from "vite";

const server = await createServer();
await server.listen();

const env = { ...process.env, GALLEY_DEV_URL: server.resolvedUrls.local[0] };
// Set by some Electron-based terminals; it would make Electron run as Node.
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(electron, ["."], { stdio: "inherit", env });
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

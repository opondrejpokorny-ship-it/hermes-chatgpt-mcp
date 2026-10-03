import { loadConfig } from "./config.js";
import { startHttpServer } from "./server.js";

const config = loadConfig();
void startHttpServer(config).catch(() => {
  console.error("Hermes MCP adapter could not start");
  process.exitCode = 1;
});

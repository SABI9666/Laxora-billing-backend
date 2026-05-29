import { createApp } from "./app";
import { env } from "./config/env";

const app = createApp();

// Cloud Run injects PORT; bind to 0.0.0.0 so the container is reachable.
const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(`Laxora billing API listening on port ${env.port} (${env.nodeEnv})`);
});

// Graceful shutdown so in-flight requests finish on container stop.
const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

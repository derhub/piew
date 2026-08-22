import { ReviewServer } from "./server";

const server = new ReviewServer();
await server.start(4173);

// Keep alive
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});

// server.js (entrypoint)
require("dotenv").config();

const { createApp } = require("./src/app");

const { app, ensureSpeakingLinksOnStartup } = createApp();

const basePort = Number(process.env.PORT || 8080);
const isProd = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const strictPort = String(process.env.PORT_STRICT || "").trim() === "1";

function startServer(port, attempt = 0) {
  const server = app.listen(port, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : port;
    console.log(`API+UI running on http://localhost:${actualPort}`);
    void ensureSpeakingLinksOnStartup();
  });

  server.on("error", (err) => {
    const code = String(err && err.code ? err.code : "");
    if (code === "EADDRINUSE") {
      // In production (or when strict), fail fast.
      if (isProd || strictPort) {
        console.error(`Port ${port} is already in use.`);
        console.error(`- Stop the other process using ${port}, or set PORT in .env (e.g. PORT=8081) and retry.`);
        process.exit(1);
        return;
      }

      // In dev, auto-fallback to the next port to avoid constant restarts.
      const maxAttempts = 20;
      if (attempt >= maxAttempts) {
        console.error(`Could not find a free port starting from ${basePort} (tried ${maxAttempts + 1} ports).`);
        console.error(`- Stop the other process, or set PORT in .env to a free port.`);
        process.exit(1);
        return;
      }
      const nextPort = port + 1;
      console.log(`Port ${port} is already in use; trying ${nextPort}...`);
      try { server.close(); } catch {}
      startServer(nextPort, attempt + 1);
      return;
    }

    console.error("Server failed to start:", err);
    process.exit(1);
  });
}

startServer(basePort);

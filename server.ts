import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApiRouter } from "./server/api.ts";
import { getDb } from "./server/db.ts";

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

async function startServer(): Promise<void> {
  // Initialize SQLite database schema and default settings at startup
  getDb();

  const app = express();
  app.set("trust proxy", 1);

  // Mount Banking API under /api
  app.use("/api", createApiRouter());

  if (process.env.NODE_ENV === "production") {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) => {
      const indexFile = path.join(distDir, "index.html");
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send("Frontend build not found. Run npm run build first.");
      }
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`Online Banking Demo server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start Online Banking Demo server:", err);
  process.exit(1);
});

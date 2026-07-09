import express from "express";
import swaggerUi from "swagger-ui-express";
import { load } from "js-yaml";
import fs from "fs";
import path from "path";
import paymentsRouter from "./routes/payments";
import { registry } from "./metrics";
import { runMigrations } from "./db/migrate";
import { logger } from "./logger";

export const app = express();
app.use(express.json());

app.use("/api/v1", paymentsRouter);

const openapiSpec = load(
  fs.readFileSync(path.join(__dirname, "../docs/openapi.yaml"), "utf8")
) as object;
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

if (require.main === module) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  runMigrations()
    .then(() => {
      app.listen(PORT, () => logger.info("server_started", { port: PORT }));
    })
    .catch(err => {
      logger.error("startup_failed", { error: err.message });
      process.exit(1);
    });
}

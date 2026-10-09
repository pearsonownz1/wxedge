import app from "./app";
import { logger } from "./lib/logger";
import { transaction } from "./lib/crmData";
import { migratePipelineStages } from "./lib/crmStageMigration";
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");
transaction(migratePipelineStages).then(report => {
  logger.info(report, "Expert pipeline stage migration complete");
  app.listen(port, () => logger.info({ port }, "Notara CRM listening — trading retired"));
}).catch(err => {
  logger.fatal({ err }, "CRM stage migration failed; refusing to serve a partially migrated pipeline");
  process.exit(1);
});

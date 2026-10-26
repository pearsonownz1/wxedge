import app from "./app";
import { logger } from "./lib/logger";
import { transaction } from "./lib/crmData";
import { bootstrapCrmUpgrades } from "./lib/crmStageMigration";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");

transaction(bootstrapCrmUpgrades).then(report => {
  logger.info(report, "SellingHighs CRM stage migration & duplicate cleanup complete");
  app.listen(port, () => logger.info({ port }, "SellingHighs CRM listening"));
}).catch(err => {
  logger.fatal({ err }, "CRM startup migration failed; refusing to serve a partially migrated pipeline");
  process.exit(1);
});

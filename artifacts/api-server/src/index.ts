import app from "./app";
import { logger } from "./lib/logger";
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");
app.listen(port, () => logger.info({ port }, "Notara CRM listening — trading retired"));

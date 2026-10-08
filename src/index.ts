import { createBot } from "./bot/create-bot.js";
import { config } from "./config/index.js";
import { Database } from "./database/database.js";
import { errorSummary, logEvent } from "./logging/logger.js";

const database = new Database(config.databaseUrl);
await database.migrate();
await database.seedStarPackages(config.initialStarPackages);

const bot = createBot(config, database);
let stopping = false;

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;

  logEvent("info", "bot.shutdown", { signal });
  bot.stop();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

logEvent("info", "bot.polling.start");

try {
  await bot.start({
    onStart: async (botInfo) => {
      await bot.api.setMyCommands([
        { command: "start", description: "Что умеет бот" },
        { command: "balance", description: "Лимит и купленные запросы" },
        { command: "buy", description: "Купить запросы за Stars" },
        { command: "paysupport", description: "Поддержка по оплате" },
        { command: "diag", description: "Диагностика (только админ)" },
      ]);

      logEvent("info", "bot.started", {
        username: botInfo.username,
        model: config.proxyApiModel,
      });
    },
  });
} catch (error) {
  logEvent("error", "bot.fatal", { error: errorSummary(error) });
  process.exitCode = 1;
} finally {
  await database.close();
}

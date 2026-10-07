import { createBot } from "./bot/create-bot.js";
import { config } from "./config/index.js";

const bot = createBot(config);

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

console.info("Telegram-бот запускается в режиме long polling");

bot.start({
  onStart: (botInfo) => {
    console.info(`Telegram-бот @${botInfo.username} запущен`);
  },
});

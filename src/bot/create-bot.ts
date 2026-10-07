import { Bot, GrammyError, HttpError } from "grammy";
import type { config as appConfig } from "../config/index.js";
import { InMemoryRateLimiter } from "../rate-limit/in-memory.js";
import { ProxyApiClient, ProxyApiError } from "../services/proxyapi.js";
import { extractMentionedText, textLength } from "./message.js";

type AppConfig = typeof appConfig;

const START_TEXT = `Напиши мне суперспособность — я придумаю, чем её испортить.

Например:
Ты: Я умею летать
Я: Но только вниз.`;

const EMPTY_TEXT = "Сначала придумай суперспособность.";
const TOO_LONG_TEXT = "Слишком длинно. Опиши суперспособность короче.";
const RATE_LIMIT_TEXT = "Слишком много суперспособностей. Попробуй снова через минуту.";
const ERROR_TEXT = "Не смог придумать дебафф. Попробуй ещё раз чуть позже.";

export function createBot(config: AppConfig): Bot {
  const bot = new Bot(config.telegramBotToken);
  const proxyApi = new ProxyApiClient({
    apiKey: config.proxyApiKey,
    model: config.proxyApiModel,
    timeoutMs: config.proxyApiTimeoutMs,
    maxTokens: config.proxyApiMaxTokens,
  });
  const rateLimiter = new InMemoryRateLimiter(
    config.rateLimit.maxRequests,
    config.rateLimit.windowMs,
  );

  bot.command("start", async (ctx) => {
    if (ctx.from?.is_bot) return;
    await ctx.reply(START_TEXT);
  });

  bot.command("diag", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot || !ctx.message) return;

    const privacyMode = ctx.me.can_read_all_group_messages ? "выключен" : "включён";
    const uptimeSeconds = Math.floor(process.uptime());
    const uptime = formatUptime(uptimeSeconds);
    const balanceLines = await getBalanceLines(proxyApi);
    const lines = [
      "Диагностика бота",
      `Модель: ${config.proxyApiModel}`,
      ...balanceLines,
      `Тип чата: ${ctx.chat.type}`,
      `ID чата: ${ctx.chat.id}`,
      `ID пользователя: ${ctx.from.id}`,
      `Бот: @${ctx.me.username}`,
      `Privacy Mode: ${privacyMode}`,
      `AI timeout: ${config.proxyApiTimeoutMs / 1_000} сек.`,
      `AI max tokens: ${config.proxyApiMaxTokens}`,
      `Rate limit: ${config.rateLimit.maxRequests} запросов / ${config.rateLimit.windowMs / 1_000} сек.`,
      `Максимум сообщения: ${config.maxUserMessageLength} символов`,
      `Node.js: ${process.version}`,
      `Uptime: ${uptime}`,
    ];

    const replyOptions =
      ctx.chat.type === "private"
        ? {}
        : {
            reply_parameters: {
              message_id: ctx.message.message_id,
              allow_sending_without_reply: true,
            },
          };

    await ctx.reply(lines.join("\n"), replyOptions);
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.from.is_bot || ctx.message.text.startsWith("/start")) return;

    const isPrivate = ctx.chat.type === "private";
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    const mentionedText = extractMentionedText(ctx.message.text, ctx.me.username);

    if (!isPrivate && mentionedText === null && !isReplyToBot) return;

    const userText = (mentionedText ?? ctx.message.text).trim();
    const replyOptions = isPrivate
      ? {}
      : {
          reply_parameters: {
            message_id: ctx.message.message_id,
            allow_sending_without_reply: true,
          },
        };

    if (!userText) {
      await ctx.reply(EMPTY_TEXT, replyOptions);
      return;
    }

    if (textLength(userText) > config.maxUserMessageLength) {
      await ctx.reply(TOO_LONG_TEXT, replyOptions);
      return;
    }

    if (!rateLimiter.allow(ctx.from.id)) {
      await ctx.reply(RATE_LIMIT_TEXT, replyOptions);
      return;
    }

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch((error: unknown) => {
        console.error("Не удалось обновить typing action", summarizeError(error));
      });
    }, 4_000);

    try {
      const debuff = await proxyApi.generateDebuff(userText);
      await ctx.reply(debuff, replyOptions);
    } catch (error) {
      logProxyApiError(error);
      await ctx.reply(ERROR_TEXT, replyOptions);
    } finally {
      clearInterval(typingInterval);
    }
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) {
      console.error("Ошибка Telegram Bot API", {
        method: cause.method,
        description: cause.description,
        errorCode: cause.error_code,
      });
    } else if (cause instanceof HttpError) {
      console.error("Сетевая ошибка Telegram", { message: cause.message });
    } else {
      console.error("Неожиданная ошибка бота", summarizeError(cause));
    }
  });

  return bot;
}

function logProxyApiError(error: unknown): void {
  if (error instanceof ProxyApiError) {
    console.error("Ошибка ProxyAPI", {
      kind: error.kind,
      status: error.status,
      message: error.message,
      details: error.details,
    });
    return;
  }

  console.error("Неожиданная ошибка ProxyAPI", summarizeError(error));
}

function summarizeError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: "Неизвестная ошибка" };
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return [
    days > 0 ? `${days}д` : "",
    hours > 0 ? `${hours}ч` : "",
    minutes > 0 ? `${minutes}м` : "",
    `${seconds}с`,
  ]
    .filter(Boolean)
    .join(" ");
}

async function getBalanceLines(proxyApi: ProxyApiClient): Promise<string[]> {
  try {
    const result = await proxyApi.getBalance();
    const lines = [`Баланс ProxyAPI: ${formatRubles(result.balance)}`];

    if (result.budget) {
      lines.push(
        `Бюджет ключа: ${formatRubles(result.budget.used)} из ${formatRubles(result.budget.limit)}`,
      );
    }

    return lines;
  } catch (error) {
    logProxyApiError(error);
    if (error instanceof ProxyApiError && error.status === 403) {
      return ["Баланс ProxyAPI: недоступен — включите разрешение «Запрос баланса» у ключа"];
    }
    return ["Баланс ProxyAPI: не удалось получить"];
  }
}

function formatRubles(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

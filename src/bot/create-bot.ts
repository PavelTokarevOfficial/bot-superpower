import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Bot, type Context, GrammyError, HttpError, InlineKeyboard, InputFile } from "grammy";
import type { config as appConfig } from "../config/index.js";
import type { Database, TelegramUser } from "../database/database.js";
import { errorSummary, logEvent } from "../logging/logger.js";
import { ProxyApiClient, ProxyApiError } from "../services/proxyapi.js";
import { extractMentionedText, textLength } from "./message.js";

type AppConfig = typeof appConfig;
const EMPTY_TEXT = "Сначала придумай суперспособность.";
const TOO_LONG_TEXT = "Слишком длинно. Опиши суперспособность короче.";
const ERROR_TEXT = "Не смог придумать дебафф. Попробуй ещё раз чуть позже.";
const ADMIN_ONLY_TEXT = "Эта команда доступна только администратору.";
const START_IMAGE_PATH = resolve(process.cwd(), "assets", "start.jpg");

export function createBot(config: AppConfig, db: Database): Bot {
  const bot = new Bot(config.telegramBotToken);
  const proxyApi = new ProxyApiClient({
    apiKey: config.proxyApiKey,
    model: config.proxyApiModel,
    timeoutMs: config.proxyApiTimeoutMs,
    maxTokens: config.proxyApiMaxTokens,
  });

  bot.use(async (ctx, next) => {
    if (ctx.message?.text && ctx.from && ctx.chat && !ctx.from.is_bot && isDirectedMessage(ctx)) {
      try {
        await db.saveInboundMessage({
          messageId: ctx.message.message_id,
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          user: telegramUser(ctx.from),
          text: ctx.message.text,
        });
      } catch (error) {
        logEvent("error", "message_save_failed", {
          userId: ctx.from.id,
          chatId: ctx.chat.id,
          ...errorSummary(error),
        });
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) return;
    const text = `Напиши мне суперспособность — я придумаю, как ее улучшить.

Бесплатно: ${config.dailyFreeRequests} запросов в сутки.
/balance — остаток запросов
/buy — купить дополнительные запросы за ⭐️

Например:
Ты: Я умею летать
Я: Но только вниз.`;
    if (existsSync(START_IMAGE_PATH)) {
      try {
        await ctx.replyWithPhoto(new InputFile(START_IMAGE_PATH), { caption: text });
        return;
      } catch (error) {
        logEvent("warn", "start_image_failed", {
          userId: ctx.from.id,
          ...errorSummary(error),
        });
      }
    }
    await ctx.reply(text);
  });

  bot.command("balance", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) return;
    const status = await db.quotaStatus(telegramUser(ctx.from), config.dailyFreeRequests);
    await ctx.reply(
      `Бесплатных запросов сегодня: ${status.dailyRemaining} из ${config.dailyFreeRequests}\n` +
        `Купленных запросов: ${status.paidCredits}`,
    );
  });

  bot.command("buy", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat.type !== "private") {
      await ctx.reply("Покупка доступна только в личном чате с ботом.");
      return;
    }
    const packages = await db.listStarPackages();
    if (packages.length === 0) {
      await ctx.reply("Пакеты временно недоступны. Попробуй позже.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const item of packages) {
      keyboard.text(`${item.credits} запросов — ${item.stars} ⭐️`, `buy_package:${item.id}`).row();
    }
    await ctx.reply(
      [
        "Выбери пакет запросов:",
        "",
        ...packages.map((item) => `${item.credits} запросов — ${item.stars} ⭐️`),
        "",
        "Купленные запросы не сгорают.",
      ].join("\n"),
      { reply_markup: keyboard },
    );
  });

  bot.callbackQuery(/^buy_package:(\d+)$/u, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Готовлю счёт…" });
    if (ctx.from.is_bot || ctx.chat?.type !== "private") return;
    const packageId = Number(ctx.match[1]);
    if (!Number.isSafeInteger(packageId) || packageId <= 0) return;
    const payload = `credits:v2:${randomUUID()}`;
    const invoice = await db.createPaymentInvoice(telegramUser(ctx.from), packageId, payload);
    if (!invoice) {
      await ctx.reply("Этот пакет больше недоступен. Открой /buy и выбери другой.");
      return;
    }
    logEvent("info", "payment_invoice_requested", {
      userId: ctx.from.id,
      packageId: invoice.id,
      stars: invoice.stars,
      credits: invoice.credits,
    });
    await ctx.replyWithInvoice(
      `${invoice.credits} дополнительных запросов`,
      "Дополнительные запросы не сгорают и используются после бесплатного дневного лимита.",
      invoice.payload,
      "XTR",
      [{ label: `${invoice.credits} запросов`, amount: invoice.stars }],
    );
  });

  bot.command("paysupport", async (ctx) => {
    await ctx.reply(
      `Поддержка по оплате: ${config.paymentSupportContact}\n` +
        "Приложи скрин оплаты и свой Telegram ID.",
    );
  });

  bot.on("pre_checkout_query", async (ctx) => {
    const query = ctx.preCheckoutQuery;
    try {
      const invoice =
        query.currency === "XTR"
          ? await db.validatePaymentInvoice(
              query.invoice_payload,
              query.from.id,
              query.total_amount,
            )
          : null;
      const valid = invoice !== null;
      logEvent(valid ? "info" : "warn", "payment_precheckout", {
        userId: query.from.id,
        stars: query.total_amount,
        approved: valid,
      });
      await ctx.answerPreCheckoutQuery(
        valid,
        valid ? undefined : "Счёт устарел. Запросите новый через /buy.",
      );
    } catch (error) {
      logEvent("error", "payment_precheckout_failed", {
        userId: query.from.id,
        ...errorSummary(error),
      });
      await ctx.answerPreCheckoutQuery(false, "Не удалось проверить счёт. Попробуйте позже.");
    }
  });

  bot.on("message:successful_payment", async (ctx) => {
    if (!ctx.from) return;
    const payment = ctx.message.successful_payment;
    if (payment.currency !== "XTR") {
      logEvent("error", "payment_validation_failed", {
        userId: ctx.from.id,
        stars: payment.total_amount,
        telegramChargeId: payment.telegram_payment_charge_id,
      });
      return;
    }
    try {
      const result = await db.recordStarPayment({
        user: telegramUser(ctx.from),
        telegramChargeId: payment.telegram_payment_charge_id,
        providerChargeId: payment.provider_payment_charge_id,
        payload: payment.invoice_payload,
        stars: payment.total_amount,
      });
      logEvent("info", result.credited ? "payment_credited" : "payment_duplicate", {
        userId: ctx.from.id,
        stars: payment.total_amount,
        credits: result.credits,
        telegramChargeId: payment.telegram_payment_charge_id,
      });
      await ctx.reply(
        result.credited
          ? `Оплата прошла. Начислено ${result.credits} запросов. Баланс: ${result.paidCredits}.`
          : `Этот платёж уже учтён. Баланс: ${result.paidCredits}.`,
      );
    } catch (error) {
      logEvent("error", "payment_credit_failed", {
        userId: ctx.from.id,
        telegramChargeId: payment.telegram_payment_charge_id,
        ...errorSummary(error),
      });
      await ctx.reply("Платёж получен, но начисление задержалось. Обратитесь к администратору.");
    }
  });

  bot.command("diag", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot || !ctx.message) return;
    if (!isAdmin(config, ctx.from.id)) {
      await ctx.reply(ADMIN_ONLY_TEXT);
      return;
    }
    const privacyMode = ctx.me.can_read_all_group_messages ? "выключен" : "включён";
    const balanceLines = await getProxyBalanceLines(proxyApi);
    let databaseLine = "PostgreSQL: доступна";
    let statsLines: string[] = [];
    try {
      await db.ping();
      const stats = await db.stats();
      statsLines = [
        `Пользователей: ${stats.users}`,
        `Сохранённых сообщений: ${stats.messages}`,
        `Успешных платежей: ${stats.payments}`,
      ];
    } catch (error) {
      databaseLine = "PostgreSQL: ошибка";
      logEvent("error", "diag_database_failed", errorSummary(error));
    }
    const lines = [
      "Диагностика бота",
      `Модель: ${config.proxyApiModel}`,
      ...balanceLines,
      databaseLine,
      ...statsLines,
      `Тип чата: ${ctx.chat.type}`,
      `ID чата: ${ctx.chat.id}`,
      `ID пользователя: ${ctx.from.id}`,
      `Бот: @${ctx.me.username}`,
      `Privacy Mode: ${privacyMode}`,
      `AI timeout: ${config.proxyApiTimeoutMs / 1_000} сек.`,
      `AI max tokens: ${config.proxyApiMaxTokens}`,
      `Бесплатный лимит: ${config.dailyFreeRequests} в сутки`,
      `Bun: ${process.versions.bun ?? "неизвестно"}`,
      `Uptime: ${formatUptime(Math.floor(process.uptime()))}`,
    ];
    await replyToCommand(ctx, lines.join("\n"));
  });

  bot.command("reset_limit", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (!isAdmin(config, ctx.from.id)) {
      await ctx.reply(ADMIN_ONLY_TEXT);
      return;
    }
    const argument = ctx.match.trim().toLowerCase();
    const username = /^@([a-z0-9_]{5,32})$/iu.exec(argument)?.[1];
    const numericTarget = Number(argument);
    const target =
      argument === "all"
        ? ("all" as const)
        : username
          ? username
          : Number.isSafeInteger(numericTarget) && numericTarget > 0
            ? numericTarget
            : null;
    if (target === null) {
      await ctx.reply("Использование: /reset_limit <user_id|@username|all>");
      return;
    }
    const result = await db.resetDailyLimit(target, ctx.from.id);
    logEvent("warn", "admin_limit_reset", {
      adminId: ctx.from.id,
      target,
      targetUserId: result.targetUserId,
      affected: result.affected,
    });
    if (target !== "all" && result.targetUserId === null) {
      await ctx.reply(
        `Пользователь @${target} пока не найден. Он должен хотя бы раз написать боту.`,
      );
      return;
    }
    await ctx.reply(
      target === "all"
        ? `Суточные лимиты сброшены для всех. Записей: ${result.affected}.`
        : `Суточный лимит пользователя ${typeof target === "string" ? `@${target}` : target} сброшен.`,
    );
  });

  bot.command("payments", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot || !ctx.message) return;
    if (!isAdmin(config, ctx.from.id)) {
      await ctx.reply(ADMIN_ONLY_TEXT);
      return;
    }

    const [telegramBalance, stats] = await Promise.all([
      bot.api.getMyStarBalance(),
      db.paymentStats(),
    ]);
    const recent = stats.recent.length
      ? stats.recent.map((payment) => {
          const user = payment.username ? `@${payment.username}` : `ID ${payment.userId}`;
          return `${formatPaymentDate(payment.paidAt)} — ${user}: ${payment.stars} ⭐️`;
        })
      : ["Платежей пока нет."];

    await replyToCommand(
      ctx,
      [
        "Платежи Stars",
        `Баланс Telegram: ${formatStarAmount(telegramBalance.amount, telegramBalance.nanostar_amount)} ⭐️`,
        `Получено по БД всего: ${stats.totalStars} ⭐️`,
        `Получено сегодня: ${stats.todayStars} ⭐️`,
        `Платежей: ${stats.payments}`,
        `Плательщиков: ${stats.payers}`,
        "",
        "Последние платежи:",
        ...recent,
      ].join("\n"),
    );
  });

  bot.command("withdraw_stars", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot || !ctx.message) return;
    if (!isAdmin(config, ctx.from.id)) {
      await ctx.reply(ADMIN_ONLY_TEXT);
      return;
    }
    const balance = await bot.api.getMyStarBalance();
    logEvent("warn", "admin_withdrawal_instructions_requested", {
      adminId: ctx.from.id,
      balance: balance.amount,
    });
    await replyToCommand(
      ctx,
      `Баланс бота: ${formatStarAmount(balance.amount, balance.nanostar_amount)} ⭐️\n\n` +
        "Вывод нельзя подтвердить командой бота: Telegram требует действие владельца и 2FA. " +
        "Открой профиль бота → Изменить/Edit → Баланс/Balance → Вывести/Withdraw. " +
        "Telegram откроет Fragment для указания TON-кошелька. Минимум для вывода — 1000 ⭐️; " +
        "заработанные Stars становятся доступными для вывода через 21 день.",
    );
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.from.is_bot || ctx.message.text.startsWith("/")) return;
    const userText = getDirectedText(ctx);
    if (userText === null) return;
    const replyOptions =
      ctx.chat.type === "private"
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

    const quota = await db.reserveRequest(telegramUser(ctx.from), config.dailyFreeRequests);
    if (!quota.allowed) {
      await ctx.reply(
        `Лимит ${config.dailyFreeRequests} запросов на сегодня закончился. ` +
          "Дополнительные запросы можно купить через /buy.",
        replyOptions,
      );
      return;
    }

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch((error: unknown) => {
        logEvent("warn", "typing_action_failed", errorSummary(error));
      });
    }, 4_000);
    try {
      const debuff = await proxyApi.generateDebuff(userText);
      await ctx.reply(debuff, replyOptions);
    } catch (error) {
      await db.releaseReservation(quota.reservation).catch((releaseError) => {
        logEvent("error", "quota_release_failed", {
          userId: ctx.from.id,
          ...errorSummary(releaseError),
        });
      });
      logProxyApiError(error);
      await ctx.reply(ERROR_TEXT, replyOptions);
    } finally {
      clearInterval(typingInterval);
    }
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) {
      logEvent("error", "telegram_api_error", {
        method: cause.method,
        description: cause.description,
        errorCode: cause.error_code,
      });
    } else if (cause instanceof HttpError) {
      logEvent("error", "telegram_network_error", { message: cause.message });
    } else logEvent("error", "bot_unexpected_error", errorSummary(cause));
  });
  return bot;
}

function isDirectedMessage(ctx: Context): boolean {
  if (!ctx.message?.text || !ctx.chat) return false;
  if (ctx.chat.type === "private") return true;
  return (
    ctx.message.reply_to_message?.from?.id === ctx.me.id ||
    extractMentionedText(ctx.message.text, ctx.me.username) !== null ||
    ctx.message.text.startsWith("/")
  );
}

function getDirectedText(ctx: {
  chat: { type: string };
  message: { text: string; reply_to_message?: { from?: { id: number } } };
  me: { id: number; username: string };
}): string | null {
  if (ctx.chat.type === "private") return ctx.message.text.trim();
  const mentioned = extractMentionedText(ctx.message.text, ctx.me.username);
  if (mentioned !== null) return mentioned.trim();
  return ctx.message.reply_to_message?.from?.id === ctx.me.id ? ctx.message.text.trim() : null;
}

function telegramUser(from: { id: number; username?: string; first_name: string }): TelegramUser {
  return {
    id: from.id,
    firstName: from.first_name,
    ...(from.username ? { username: from.username } : {}),
  };
}

function isAdmin(config: AppConfig, userId: number): boolean {
  return config.adminIds.has(userId);
}

async function replyToCommand(
  ctx: {
    chat: { type: string };
    message: { message_id: number };
    reply: (text: string, options?: object) => Promise<unknown>;
  },
  text: string,
): Promise<void> {
  if (ctx.chat.type === "private") await ctx.reply(text);
  else {
    await ctx.reply(text, {
      reply_parameters: {
        message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
      },
    });
  }
}

function logProxyApiError(error: unknown): void {
  if (error instanceof ProxyApiError) {
    logEvent("error", "proxyapi_error", {
      kind: error.kind,
      status: error.status,
      message: error.message,
      details: error.details,
    });
  } else logEvent("error", "proxyapi_unexpected_error", errorSummary(error));
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

async function getProxyBalanceLines(proxyApi: ProxyApiClient): Promise<string[]> {
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

function formatStarAmount(amount: number, nanostarAmount = 0): string {
  const value = amount + nanostarAmount / 1_000_000_000;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 9 }).format(value);
}

function formatPaymentDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kirov",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

import "dotenv/config";

function requireEnv(name: "TELEGRAM_BOT_TOKEN" | "PROXYAPI_API_KEY" | "PROXYAPI_MODEL"): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения ${name}. Проверьте файл .env.`);
  }

  return value;
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  proxyApiKey: requireEnv("PROXYAPI_API_KEY"),
  proxyApiModel: requireEnv("PROXYAPI_MODEL"),
  proxyApiTimeoutMs: 90_000,
  proxyApiMaxTokens: 512,
  maxUserMessageLength: 500,
  rateLimit: {
    maxRequests: 5,
    windowMs: 60_000,
  },
} as const;

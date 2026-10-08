type RequiredEnv =
  | "TELEGRAM_BOT_TOKEN"
  | "PROXYAPI_API_KEY"
  | "PROXYAPI_MODEL"
  | "DATABASE_URL"
  | "ADMIN_IDS";

function requireEnv(name: RequiredEnv): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения ${name}. Проверьте файл .env.`);
  }

  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} должен быть положительным целым числом.`);
  }
  return value;
}

function adminIds(value: string): ReadonlySet<number> {
  const ids = value.split(",").map((item) => Number(item.trim()));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("ADMIN_IDS должен содержать Telegram ID через запятую.");
  }
  return new Set(ids);
}

function starPackages(
  value: string | undefined,
): ReadonlyArray<{ credits: number; stars: number }> {
  const raw = value?.trim() || "5:10,15:28,50:85";
  const packages = raw.split(",").map((item) => {
    const [credits, stars] = item.split(":").map(Number);
    if (
      !Number.isSafeInteger(credits) ||
      !credits ||
      credits <= 0 ||
      !Number.isSafeInteger(stars) ||
      !stars ||
      stars <= 0
    ) {
      throw new Error("STARS_PACKAGES должен иметь формат credits:stars, например 10:1,60:5.");
    }
    return { credits, stars };
  });
  if (packages.length === 0) throw new Error("STARS_PACKAGES не должен быть пустым.");
  return packages;
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  proxyApiKey: requireEnv("PROXYAPI_API_KEY"),
  proxyApiModel: requireEnv("PROXYAPI_MODEL"),
  databaseUrl: requireEnv("DATABASE_URL"),
  adminIds: adminIds(requireEnv("ADMIN_IDS")),
  proxyApiTimeoutMs: 90_000,
  proxyApiMaxTokens: 512,
  maxUserMessageLength: 500,
  dailyFreeRequests: positiveInt("DAILY_FREE_REQUESTS", 5),
  initialStarPackages: starPackages(process.env.STARS_PACKAGES),
  paymentSupportContact: process.env.PAYMENT_SUPPORT_CONTACT?.trim() || "Telegram ID: 832766702",
} as const;

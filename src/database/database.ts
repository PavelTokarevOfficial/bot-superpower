import postgres, { type Sql, type TransactionSql } from "postgres";

export type TelegramUser = {
  id: number;
  username?: string;
  firstName?: string;
};

export type QuotaReservation = {
  userId: number;
  source: "daily" | "paid";
  usageDate: string;
};

export type QuotaStatus = {
  dailyUsed: number;
  dailyRemaining: number;
  paidCredits: number;
};

export type PaymentStats = {
  totalStars: number;
  todayStars: number;
  payments: number;
  payers: number;
  recent: Array<{
    username: string | null;
    userId: number;
    stars: number;
    paidAt: Date;
  }>;
};

export type StarPackage = {
  id: number;
  stars: number;
  credits: number;
};

export type PaymentInvoice = StarPackage & {
  payload: string;
  userId: number;
};

export class Database {
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        paid_credits INTEGER NOT NULL DEFAULT 0 CHECK (paid_credits >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS daily_usage (
        telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
        usage_date DATE NOT NULL,
        requests_used INTEGER NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
        PRIMARY KEY (telegram_user_id, usage_date)
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        id BIGSERIAL PRIMARY KEY,
        telegram_message_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        chat_type TEXT NOT NULL,
        telegram_user_id BIGINT NOT NULL,
        telegram_username TEXT,
        text TEXT NOT NULL,
        bot_response TEXT,
        responded_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (chat_id, telegram_message_id)
      );

      ALTER TABLE inbound_messages
        ADD COLUMN IF NOT EXISTS telegram_username TEXT,
        ADD COLUMN IF NOT EXISTS bot_response TEXT,
        ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS inbound_messages_user_idx
        ON inbound_messages (telegram_user_id, received_at DESC);

      CREATE TABLE IF NOT EXISTS star_payments (
        id BIGSERIAL PRIMARY KEY,
        telegram_payment_charge_id TEXT NOT NULL UNIQUE,
        provider_payment_charge_id TEXT,
        telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id),
        invoice_payload TEXT NOT NULL,
        stars_amount INTEGER NOT NULL CHECK (stars_amount > 0),
        credits_added INTEGER NOT NULL CHECK (credits_added > 0),
        paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS star_packages (
        id SERIAL PRIMARY KEY,
        stars_amount INTEGER NOT NULL CHECK (stars_amount > 0),
        credits_amount INTEGER NOT NULL CHECK (credits_amount > 0),
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (stars_amount, credits_amount)
      );

      CREATE TABLE IF NOT EXISTS payment_invoices (
        payload TEXT PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id),
        package_id INTEGER NOT NULL REFERENCES star_packages(id),
        stars_amount INTEGER NOT NULL CHECK (stars_amount > 0),
        credits_amount INTEGER NOT NULL CHECK (credits_amount > 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS payment_invoices_user_idx
        ON payment_invoices (telegram_user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS admin_actions (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT NOT NULL,
        action TEXT NOT NULL,
        target_user_id BIGINT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async seedStarPackages(
    packages: ReadonlyArray<{ credits: number; stars: number }>,
  ): Promise<void> {
    const [{ count }] = await this.sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM star_packages
    `;
    if (count > 0) return;
    await this.sql.begin(async (tx) => {
      for (const [index, item] of packages.entries()) {
        await tx`
          INSERT INTO star_packages (stars_amount, credits_amount, sort_order)
          VALUES (${item.stars}, ${item.credits}, ${index})
          ON CONFLICT (stars_amount, credits_amount) DO NOTHING
        `;
      }
    });
  }

  async listStarPackages(): Promise<StarPackage[]> {
    const rows = await this.sql<
      Array<{ id: number; stars_amount: number; credits_amount: number }>
    >`
      SELECT id, stars_amount, credits_amount
      FROM star_packages
      WHERE is_active = TRUE
      ORDER BY sort_order, stars_amount, id
    `;
    return rows.map((row) => ({
      id: row.id,
      stars: row.stars_amount,
      credits: row.credits_amount,
    }));
  }

  async createPaymentInvoice(
    user: TelegramUser,
    packageId: number,
    payload: string,
  ): Promise<PaymentInvoice | null> {
    return this.sql.begin(async (tx) => {
      await upsertUser(tx, user);
      const [item] = await tx<[{ id: number; stars_amount: number; credits_amount: number }]>`
        SELECT id, stars_amount, credits_amount
        FROM star_packages
        WHERE id = ${packageId} AND is_active = TRUE
      `;
      if (!item) return null;
      await tx`
        INSERT INTO payment_invoices (
          payload, telegram_user_id, package_id, stars_amount, credits_amount
        ) VALUES (${payload}, ${user.id}, ${item.id}, ${item.stars_amount}, ${item.credits_amount})
      `;
      return {
        id: item.id,
        stars: item.stars_amount,
        credits: item.credits_amount,
        payload,
        userId: user.id,
      };
    });
  }

  async validatePaymentInvoice(
    payload: string,
    userId: number,
    stars: number,
  ): Promise<PaymentInvoice | null> {
    const [invoice] = await this.sql<
      [{ package_id: number; stars_amount: number; credits_amount: number }]
    >`
      SELECT package_id, stars_amount, credits_amount
      FROM payment_invoices
      WHERE payload = ${payload}
        AND telegram_user_id = ${userId}
        AND stars_amount = ${stars}
        AND status = 'pending'
    `;
    return invoice
      ? {
          id: invoice.package_id,
          stars: invoice.stars_amount,
          credits: invoice.credits_amount,
          payload,
          userId,
        }
      : null;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async saveInboundMessage(input: {
    messageId: number;
    chatId: number;
    chatType: string;
    user: TelegramUser;
    text: string;
  }): Promise<void> {
    await this.ensureUser(input.user);
    await this.sql`
      INSERT INTO inbound_messages (
        telegram_message_id, chat_id, chat_type, telegram_user_id, telegram_username, text
      ) VALUES (
        ${input.messageId}, ${input.chatId}, ${input.chatType}, ${input.user.id},
        ${input.user.username ?? null}, ${input.text}
      )
      ON CONFLICT (chat_id, telegram_message_id) DO UPDATE SET
        telegram_username = EXCLUDED.telegram_username
    `;
  }

  async saveBotResponse(input: {
    messageId: number;
    chatId: number;
    response: string;
  }): Promise<void> {
    await this.sql`
      UPDATE inbound_messages
      SET bot_response = ${input.response}, responded_at = NOW()
      WHERE chat_id = ${input.chatId} AND telegram_message_id = ${input.messageId}
    `;
  }

  async reserveRequest(
    user: TelegramUser,
    dailyLimit: number,
  ): Promise<
    | { allowed: true; reservation: QuotaReservation; status: QuotaStatus }
    | { allowed: false; status: QuotaStatus }
  > {
    return this.sql.begin(async (tx) => {
      await upsertUser(tx, user);
      const [lockedUser] = await tx<[{ paid_credits: number }]>`
        SELECT paid_credits FROM users
        WHERE telegram_user_id = ${user.id}
        FOR UPDATE
      `;
      await tx`
        INSERT INTO daily_usage (telegram_user_id, usage_date, requests_used)
        VALUES (${user.id}, CURRENT_DATE, 0)
        ON CONFLICT DO NOTHING
      `;
      const [usage] = await tx<[{ requests_used: number; usage_date: string }]>`
        SELECT requests_used, usage_date::text AS usage_date FROM daily_usage
        WHERE telegram_user_id = ${user.id} AND usage_date = CURRENT_DATE
        FOR UPDATE
      `;
      const used = usage?.requests_used ?? 0;
      const usageDate = usage?.usage_date;
      if (!usageDate) throw new Error("Не удалось создать запись суточного лимита.");
      const paid = lockedUser?.paid_credits ?? 0;

      if (used < dailyLimit) {
        const nextUsed = used + 1;
        await tx`
          UPDATE daily_usage SET requests_used = ${nextUsed}
          WHERE telegram_user_id = ${user.id} AND usage_date = ${usageDate}
        `;
        return {
          allowed: true as const,
          reservation: { userId: user.id, source: "daily" as const, usageDate },
          status: { dailyUsed: nextUsed, dailyRemaining: dailyLimit - nextUsed, paidCredits: paid },
        };
      }

      if (paid > 0) {
        await tx`
          UPDATE users SET paid_credits = paid_credits - 1, updated_at = NOW()
          WHERE telegram_user_id = ${user.id}
        `;
        return {
          allowed: true as const,
          reservation: { userId: user.id, source: "paid" as const, usageDate },
          status: { dailyUsed: used, dailyRemaining: 0, paidCredits: paid - 1 },
        };
      }

      return {
        allowed: false as const,
        status: { dailyUsed: used, dailyRemaining: 0, paidCredits: 0 },
      };
    });
  }

  async releaseReservation(reservation: QuotaReservation): Promise<void> {
    if (reservation.source === "paid") {
      await this.sql`
        UPDATE users SET paid_credits = paid_credits + 1, updated_at = NOW()
        WHERE telegram_user_id = ${reservation.userId}
      `;
      return;
    }
    await this.sql`
      UPDATE daily_usage SET requests_used = GREATEST(requests_used - 1, 0)
      WHERE telegram_user_id = ${reservation.userId}
        AND usage_date = ${reservation.usageDate}
    `;
  }

  async quotaStatus(user: TelegramUser, dailyLimit: number): Promise<QuotaStatus> {
    await this.ensureUser(user);
    const [row] = await this.sql<[{ requests_used: number; paid_credits: number }]>`
      SELECT COALESCE(d.requests_used, 0)::int AS requests_used, u.paid_credits
      FROM users u
      LEFT JOIN daily_usage d
        ON d.telegram_user_id = u.telegram_user_id AND d.usage_date = CURRENT_DATE
      WHERE u.telegram_user_id = ${user.id}
    `;
    const used = row?.requests_used ?? 0;
    return {
      dailyUsed: used,
      dailyRemaining: Math.max(dailyLimit - used, 0),
      paidCredits: row?.paid_credits ?? 0,
    };
  }

  async resetDailyLimit(
    target: number | string | "all",
    adminId: number,
  ): Promise<{ affected: number; targetUserId: number | null }> {
    let targetUserId: number | null = typeof target === "number" ? target : null;
    if (typeof target === "string" && target !== "all") {
      const [user] = await this.sql<[{ telegram_user_id: number }]>`
        SELECT telegram_user_id FROM users
        WHERE LOWER(username) = LOWER(${target})
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      targetUserId = user?.telegram_user_id ?? null;
    }

    const count =
      target === "all"
        ? await this.sql`DELETE FROM daily_usage WHERE usage_date = CURRENT_DATE RETURNING 1`
        : targetUserId === null
          ? []
          : await this.sql`
            DELETE FROM daily_usage
            WHERE usage_date = CURRENT_DATE AND telegram_user_id = ${targetUserId}
            RETURNING 1
          `;
    await this.sql`
      INSERT INTO admin_actions (admin_user_id, action, target_user_id, metadata)
      VALUES (
        ${adminId}, 'reset_daily_limit', ${target === "all" ? null : targetUserId},
        ${this.sql.json({ scope: target === "all" ? "all" : "user", requestedTarget: target, affected: count.length })}
      )
    `;
    return { affected: count.length, targetUserId };
  }

  async recordStarPayment(input: {
    user: TelegramUser;
    telegramChargeId: string;
    providerChargeId: string;
    payload: string;
    stars: number;
  }): Promise<{ credited: boolean; paidCredits: number; credits: number }> {
    return this.sql.begin(async (tx) => {
      await upsertUser(tx, input.user);
      const [invoice] = await tx<[{ credits_amount: number; stars_amount: number }]>`
        SELECT credits_amount, stars_amount
        FROM payment_invoices
        WHERE payload = ${input.payload} AND telegram_user_id = ${input.user.id}
        FOR UPDATE
      `;
      if (!invoice || invoice.stars_amount !== input.stars) {
        throw new Error("Платёж не соответствует счёту из базы данных.");
      }
      const inserted = await tx`
        INSERT INTO star_payments (
          telegram_payment_charge_id, provider_payment_charge_id, telegram_user_id,
          invoice_payload, stars_amount, credits_added
        ) VALUES (
          ${input.telegramChargeId}, ${input.providerChargeId}, ${input.user.id},
          ${input.payload}, ${input.stars}, ${invoice.credits_amount}
        )
        ON CONFLICT (telegram_payment_charge_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) {
        await tx`
          UPDATE users SET paid_credits = paid_credits + ${invoice.credits_amount}, updated_at = NOW()
          WHERE telegram_user_id = ${input.user.id}
        `;
        await tx`
          UPDATE payment_invoices SET status = 'paid', paid_at = NOW()
          WHERE payload = ${input.payload}
        `;
      }
      const [user] = await tx<[{ paid_credits: number }]>`
        SELECT paid_credits FROM users WHERE telegram_user_id = ${input.user.id}
      `;
      return {
        credited: inserted.length > 0,
        paidCredits: user?.paid_credits ?? 0,
        credits: invoice.credits_amount,
      };
    });
  }

  async stats(): Promise<{ users: number; messages: number; payments: number }> {
    const [row] = await this.sql<[{ users: number; messages: number; payments: number }]>`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM inbound_messages) AS messages,
        (SELECT COUNT(*)::int FROM star_payments) AS payments
    `;
    return row ?? { users: 0, messages: 0, payments: 0 };
  }

  async paymentStats(): Promise<PaymentStats> {
    const [totals] = await this.sql<
      [{ total_stars: number; today_stars: number; payments: number; payers: number }]
    >`
      SELECT
        COALESCE(SUM(stars_amount), 0)::int AS total_stars,
        COALESCE(SUM(stars_amount) FILTER (WHERE paid_at::date = CURRENT_DATE), 0)::int AS today_stars,
        COUNT(*)::int AS payments,
        COUNT(DISTINCT telegram_user_id)::int AS payers
      FROM star_payments
    `;
    const recent = await this.sql<
      Array<{
        username: string | null;
        telegram_user_id: number;
        stars_amount: number;
        paid_at: Date;
      }>
    >`
      SELECT u.username, p.telegram_user_id, p.stars_amount, p.paid_at
      FROM star_payments p
      JOIN users u ON u.telegram_user_id = p.telegram_user_id
      ORDER BY p.paid_at DESC
      LIMIT 10
    `;

    return {
      totalStars: totals?.total_stars ?? 0,
      todayStars: totals?.today_stars ?? 0,
      payments: totals?.payments ?? 0,
      payers: totals?.payers ?? 0,
      recent: recent.map((payment) => ({
        username: payment.username,
        userId: payment.telegram_user_id,
        stars: payment.stars_amount,
        paidAt: payment.paid_at,
      })),
    };
  }

  private async ensureUser(user: TelegramUser): Promise<void> {
    await upsertUser(this.sql, user);
  }
}

async function upsertUser(sql: Sql | TransactionSql, user: TelegramUser): Promise<void> {
  await sql`
    INSERT INTO users (telegram_user_id, username, first_name)
    VALUES (${user.id}, ${user.username ?? null}, ${user.firstName ?? null})
    ON CONFLICT (telegram_user_id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      updated_at = NOW()
  `;
}

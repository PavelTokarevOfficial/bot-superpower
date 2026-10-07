import { DEBUFF_SYSTEM_PROMPT } from "../prompts/debuff.js";

const PROXYAPI_URL = "https://api.proxyapi.ru/v1/chat/completions";
const PROXYAPI_BALANCE_URL = "https://api.proxyapi.ru/proxyapi/balance";

type ProxyApiClientOptions = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
};

export type ProxyApiBalance = {
  balance: number;
  budget?: {
    limit: number;
    used: number;
  };
};

export class ProxyApiError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "invalid-response" | "network",
    readonly status?: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProxyApiError";
  }
}

export class ProxyApiClient {
  constructor(private readonly options: ProxyApiClientOptions) {}

  async getBalance(): Promise<ProxyApiBalance> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.options.timeoutMs, 5_000));

    try {
      const response = await fetch(PROXYAPI_BALANCE_URL, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ProxyApiError(
          `ProxyAPI balance вернул HTTP ${response.status}`,
          "http",
          response.status,
          await extractErrorDetails(response),
        );
      }

      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.balance !== "number") {
        throw new ProxyApiError("ProxyAPI вернул неожиданный ответ баланса", "invalid-response");
      }

      const budget = payload.budget;
      if (isRecord(budget) && typeof budget.limit === "number" && typeof budget.used === "number") {
        return {
          balance: payload.balance,
          budget: { limit: budget.limit, used: budget.used },
        };
      }

      return { balance: payload.balance };
    } catch (error) {
      if (error instanceof ProxyApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProxyApiError("Истекло время ожидания баланса ProxyAPI", "timeout");
      }
      throw new ProxyApiError("Не удалось запросить баланс ProxyAPI", "network");
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateDebuff(superpower: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(PROXYAPI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createRequestBody(this.options.model, superpower, this.options.maxTokens),
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ProxyApiError(
          `ProxyAPI вернул HTTP ${response.status}`,
          "http",
          response.status,
          await extractErrorDetails(response),
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProxyApiError("ProxyAPI вернул невалидный JSON", "invalid-response");
      }

      const content = extractContent(payload);
      if (!content) {
        throw new ProxyApiError(
          "ProxyAPI вернул пустой или неожиданный ответ",
          "invalid-response",
          undefined,
          getResponseMetadata(payload),
        );
      }

      return normalizeDebuff(content);
    } catch (error) {
      if (error instanceof ProxyApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ProxyApiError("Истекло время ожидания ProxyAPI", "timeout");
      }

      throw new ProxyApiError("Сетевая ошибка при обращении к ProxyAPI", "network");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createRequestBody(
  model: string,
  superpower: string,
  maxTokens: number,
): Record<string, unknown> {
  const common = {
    model,
    messages: [
      { role: "system", content: DEBUFF_SYSTEM_PROMPT },
      { role: "user", content: superpower },
    ],
    temperature: 1,
  };

  if (model.startsWith("openai/")) {
    return {
      ...common,
      max_completion_tokens: maxTokens,
      reasoning_effort: "low",
    };
  }

  return {
    ...common,
    max_tokens: maxTokens,
    reasoning_effort: "minimal",
  };
}

async function extractErrorDetails(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      return { responseType: typeof payload };
    }

    if (typeof payload.detail === "string") {
      return { message: payload.detail };
    }

    if (!isRecord(payload.error)) return { responseType: "object" };

    const { message, type, param, code } = payload.error;
    return {
      message: typeof message === "string" ? message : undefined,
      type: typeof type === "string" ? type : undefined,
      param: typeof param === "string" ? param : undefined,
      code: typeof code === "string" ? code : undefined,
    };
  } catch {
    return { responseType: "non-json" };
  }
}

export function getResponseMetadata(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return { payloadType: typeof payload };
  }

  const firstChoice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const choice = isRecord(firstChoice) ? firstChoice : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  const tokenDetails =
    usage && isRecord(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : undefined;
  const content = message?.content;
  const reasoning = message?.reasoning;

  return {
    model: typeof payload.model === "string" ? payload.model : undefined,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    nativeFinishReason:
      typeof choice?.native_finish_reason === "string" ? choice.native_finish_reason : undefined,
    contentType: content === null ? "null" : typeof content,
    contentLength: typeof content === "string" ? content.length : undefined,
    reasoningLength: typeof reasoning === "string" ? reasoning.length : undefined,
    completionTokens:
      typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined,
    reasoningTokens:
      typeof tokenDetails?.reasoning_tokens === "number"
        ? tokenDetails.reasoning_tokens
        : undefined,
  };
}

export function extractContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null;
  }

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return null;
  }

  const { content } = firstChoice.message;
  if (typeof content !== "string") {
    return null;
  }

  return content.trim() || null;
}

export function normalizeDebuff(content: string, maxLength = 180): string {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/giu, " ").trim();
  const sentences = Array.from(
    new Intl.Segmenter("ru", { granularity: "sentence" }).segment(withoutThinking),
    ({ segment }) => cleanSentence(segment),
  ).filter(Boolean);
  const preferred =
    sentences.find((sentence) => /^Вопрос не ко мне, но(?:\s|[,:.!?—-]|$)/iu.test(sentence)) ??
    sentences.find((sentence) => /^Но(?:\s|[,:.!?—-]|$)/iu.test(sentence)) ??
    sentences[0];

  if (!preferred) {
    throw new ProxyApiError("ProxyAPI вернул пустой ответ после очистки", "invalid-response");
  }

  if (Array.from(preferred).length <= maxLength) {
    return preferred;
  }

  const characters = Array.from(preferred);
  const shortened = characters.slice(0, maxLength + 1).join("");
  const lastWhitespace = shortened.search(/\s+\S*$/u);
  const safeCut =
    lastWhitespace > 0
      ? shortened.slice(0, lastWhitespace)
      : characters.slice(0, maxLength).join("");

  return `${safeCut.trimEnd().replace(/[.,;:!?—-]+$/u, "")}…`;
}

function cleanSentence(sentence: string): string {
  return sentence
    .trim()
    .replace(/^(?:[-*•]+|\d+[.)])\s*/u, "")
    .replace(/^[[\]"'«»“”„]+|[[\]"'«»“”„]+$/gu, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

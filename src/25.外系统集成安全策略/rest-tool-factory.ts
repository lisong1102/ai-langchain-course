// rest-tool-factory.ts
import { tool } from "@langchain/core/tools";
import { z, ZodObject, ZodRawShape } from "zod";

type AuthStrategy =
  | { type: "none" }
  | { type: "apiKey"; header: string; key: string }
  | { type: "bearer"; token: string | (() => Promise<string>) }
  | { type: "basic"; username: string; password: string };

interface RestToolConfig<T extends ZodRawShape> {
  name: string;
  description: string;
  schema: ZodObject<T>;
  baseURL: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

  auth?: AuthStrategy;
  headers?: Record<string, string>;

  buildBody?: (input: z.infer<ZodObject<T>>) => unknown;
  buildPath?: (input: z.infer<ZodObject<T>>) => string;
  buildQuery?: (input: z.infer<ZodObject<T>>) => Record<string, string>;

  timeout?: number;
  maxRetries?: number;
  retryOn?: number[];

  // 把 API 响应转成 Tool 输出
  transformResponse?: (data: any) => unknown;
  // 降级：当 API 失败时返回什么
  fallback?: (input: z.infer<ZodObject<T>>) => string;
}

async function resolveAuthHeader(
  auth: AuthStrategy,
): Promise<Record<string, string>> {
  switch (auth.type) {
    case "none":
      return {};
    case "apiKey":
      return { [auth.header]: auth.key };
    case "bearer": {
      const token =
        typeof auth.token === "function" ? await auth.token() : auth.token;
      return { Authorization: `Bearer ${token}` };
    }
    case "basic": {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString(
        "base64",
      );
      return { Authorization: `Basic ${encoded}` };
    }
  }
}

export function createRestTool<T extends ZodRawShape>(
  config: RestToolConfig<T>,
) {
  return tool(
    async (input) => {
      const path = config.buildPath ? config.buildPath(input) : config.endpoint;
      const query = config.buildQuery
        ? "?" + new URLSearchParams(config.buildQuery(input)).toString()
        : "";
      const url = `${config.baseURL}${path}${query}`;

      const authHeaders = config.auth
        ? await resolveAuthHeader(config.auth)
        : {};
      const fetchOptions: RequestInit = {
        method: config.method,
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
          ...authHeaders,
        },
        signal: AbortSignal.timeout(config.timeout ?? 10000),
      };

      if (config.method !== "GET" && config.buildBody) {
        fetchOptions.body = JSON.stringify(config.buildBody(input));
      }

      const maxRetries = config.maxRetries ?? 2;
      const retryOn = config.retryOn ?? [429, 500, 502, 503, 504];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, fetchOptions);

          if (retryOn.includes(response.status) && attempt < maxRetries) {
            // Retry-After 头优先；没有就指数退避
            const retryAfter = response.headers.get("Retry-After");
            const backoff = retryAfter
              ? parseInt(retryAfter) * 1000
              : Math.min(1000 * 2 ** attempt, 8000);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }

          const data = await response.json().catch(() => null);

          if (!response.ok) {
            return JSON.stringify({
              success: false,
              status: response.status,
              error: data,
            });
          }

          const result = config.transformResponse
            ? config.transformResponse(data)
            : data;
          return JSON.stringify({ success: true, data: result });
        } catch (error) {
          if (attempt >= maxRetries) {
            if (config.fallback) {
              return config.fallback(input);
            }
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "请求失败",
            });
          }
          await new Promise((r) =>
            setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)),
          );
        }
      }

      return JSON.stringify({ success: false, error: "重试已用尽" });
    },
    {
      name: config.name,
      description: config.description,
      schema: config.schema,
    },
  );
}

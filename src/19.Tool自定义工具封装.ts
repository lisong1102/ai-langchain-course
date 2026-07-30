// rest-tool-factory.ts
import { tool } from "@langchain/core/tools";
import { z, ZodObject, ZodRawShape } from "zod";

interface RestToolConfig<T extends ZodRawShape> {
  name: string;
  description: string;
  schema: ZodObject<T>;
  baseURL: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  // 从 input 生成请求体
  buildBody?: (input: z.infer<ZodObject<T>>) => unknown;
  // 从 input 生成路径（支持 :id 这种参数）
  buildPath?: (input: z.infer<ZodObject<T>>) => string;
  // 从 input 生成 query string
  buildQuery?: (input: z.infer<ZodObject<T>>) => Record<string, string>;
  timeout?: number;
  maxRetries?: number;
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

      const fetchOptions: RequestInit = {
        method: config.method,
        headers: {
          "Content-Type": "application/json",
          ...config.headers,
        },
        signal: AbortSignal.timeout(config.timeout ?? 10000),
      };

      if (config.method !== "GET" && config.buildBody) {
        fetchOptions.body = JSON.stringify(config.buildBody(input));
      }

      const maxRetries = config.maxRetries ?? 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, fetchOptions);
          const data = await response.json().catch(() => null);

          // 5xx 触发重试
          if (response.status >= 500 && attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            continue;
          }

          if (!response.ok) {
            return JSON.stringify({
              success: false,
              status: response.status,
              error: data,
            });
          }

          return JSON.stringify({ success: true, data });
        } catch (error) {
          if (attempt >= maxRetries) {
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "请求失败",
            });
          }
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
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

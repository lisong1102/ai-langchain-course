// rate-limiter.ts

// 简单的滑动窗口限流器
export class SlidingWindowLimiter {
  private timestamps: Map<string, number[]> = new Map();

  constructor(
    private maxCalls: number,
    private windowMs: number,
  ) {}

  /**
   * 返回 true 表示通过，false 表示被限流
   */
  check(key: string = "default"): boolean {
    const now = Date.now();
    const valid = (this.timestamps.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );

    if (valid.length >= this.maxCalls) {
      this.timestamps.set(key, valid);
      return false;
    }

    valid.push(now);
    this.timestamps.set(key, valid);
    return true;
  }

  /**
   * 计算还要多久才能再调用一次
   */
  retryAfter(key: string = "default"): number {
    const calls = this.timestamps.get(key) ?? [];
    if (calls.length < this.maxCalls) return 0;
    const oldest = calls[0];
    return Math.max(0, this.windowMs - (Date.now() - oldest));
  }
}

// 用法：把任何 Tool 包成"带限流的 Tool"
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";

export function withRateLimit<T extends StructuredToolInterface>(
  original: T,
  limiter: SlidingWindowLimiter,
  keyExtractor?: (input: any) => string,
) {
  return tool(
    async (input: any) => {
      const key = keyExtractor ? keyExtractor(input) : "default";

      if (!limiter.check(key)) {
        const retryAfter = limiter.retryAfter(key);
        return JSON.stringify({
          success: false,
          error: "RATE_LIMITED",
          message: `调用频率超限，约 ${Math.ceil(retryAfter / 1000)} 秒后可重试`,
          retryAfter,
        });
      }

      return original.invoke(input);
    },
    {
      name: original.name,
      description: original.description,
      schema: original.schema as any,
    },
  );
}

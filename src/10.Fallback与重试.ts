import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda } from "@langchain/core/runnables";
import { deepseekModel } from "./model/index.js";
export default async () => {
  // production-chain.ts

  const responseCache = new Map<string, string>();

  // 缓存层（命中就直接返回，未命中抛异常触发 fallback）
  const cacheLayer = new RunnableLambda<{ question: string }, string>({
    func: (input: { question: string }) => {
      const hit = responseCache.get(input.question);
      if (hit) {
        console.log("[cache] hit");
        return hit;
      }
      throw new Error("cache miss");
    },
  });

  const prompt = ChatPromptTemplate.fromTemplate(
    "你是一位智能助手。请回答：{question}",
  );
  const parser = new StringOutputParser();

  // 主链：GPT-5 + 重试 3 次
  const primaryChain = prompt
    .pipe(
      new ChatOpenAI({ model: "gpt-5" }).withRetry({
        stopAfterAttempt: 3,
        onFailedAttempt: (e) =>
          console.warn(`[gpt-5] #${e.attemptNumber}: ${e.message}`),
      }),
    )
    .pipe(parser);

  // 降级 1：GPT-4o + 重试 2 次
  const fallbackChain1 = prompt
    .pipe(
      new ChatOpenAI({ model: "gpt-4o" }).withRetry({
        stopAfterAttempt: 2,
        onFailedAttempt: (e) =>
          console.warn(`[gpt-4o] #${e.attemptNumber}: ${e.message}`),
      }),
    )
    .pipe(parser);

  // 降级 2：跨厂商，DeepSeek + 重试 2 次
  const fallbackChain2 = prompt
    .pipe(
      deepseekModel.withRetry({
        stopAfterAttempt: 2,
        onFailedAttempt: (e) =>
          console.warn(`[deepseek] #${e.attemptNumber}: ${e.message}`),
      }),
    )
    .pipe(parser);

  // 组合：缓存 → 主 → 降级 1 → 降级 2
  const productionChain = cacheLayer.withFallbacks([
    primaryChain,
    fallbackChain1,
    fallbackChain2,
  ]);

  // 顶层包装：所有方案都失败时返回兜底文案，不让用户看到 500
  async function ask(question: string): Promise<string> {
    try {
      const answer = await productionChain.invoke({ question });
      responseCache.set(question, answer); // 成功后写缓存
      return answer;
    } catch (err) {
      console.error("[critical] 所有模型不可用", err);
      return "非常抱歉，服务暂时遇到问题，请稍后再试或联系客服。";
    }
  }

  // 第一次调用：穿过缓存，走主链
  console.log(await ask("什么是 LangChain？"));
  // 第二次调用：缓存命中，毫秒级返回
  console.log(await ask("什么是 LangChain？"));
};

//超时控制
// async function invokeWithTimeout<I, O>(
//   chain: { invoke: (input: I, opts?: { signal?: AbortSignal }) => Promise<O> },
//   input: I,
//   timeoutMs: number,
// ): Promise<O> {
//   const ac = new AbortController();
//   const timer = setTimeout(() => ac.abort(), timeoutMs);

//   try {
//     return await chain.invoke(input, { signal: ac.signal });
//   } catch (err) {
//     if ((err as Error).name === "AbortError") {
//       throw new Error(`请求超时 (${timeoutMs}ms)`);
//     }
//     throw err;
//   } finally {
//     clearTimeout(timer);
//   }
// }

// const result = await invokeWithTimeout(chain, { question: "..." }, 10_000);

// react-agent.ts
import { AIMessage, createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { deepseekModel } from "./model/index.js";

// 工具 1：模拟搜索
const webSearch = tool(
  async ({ query }) => {
    // 真实场景接 Tavily / SerpAPI
    const fixtures: Record<string, string> = {
      apple: "苹果公司 2025 财年总营收为 4123 亿美元",
      microsoft: "微软公司 2025 财年总营收为 2810 亿美元",
    };
    if (query.includes("苹果") || query.toLowerCase().includes("apple")) {
      return fixtures.apple;
    }
    if (query.includes("微软") || query.toLowerCase().includes("microsoft")) {
      return fixtures.microsoft;
    }
    return `未找到与"${query}"相关的数据`;
  },
  {
    name: "web_search",
    description: "从互联网搜索公开信息，输入中英文关键词，返回一段事实性描述",
    schema: z.object({
      query: z.string().describe("搜索关键词，如 '苹果 2025 营收'"),
    }),
  },
);

// 工具 2：数学计算
const calculator = tool(
  async ({ expression }) => {
    // 生产请用 mathjs / expr-eval，这里仅做演示
    const value = Function(`"use strict"; return (${expression})`)();
    return `${expression} = ${value}`;
  },
  {
    name: "calculator",
    description: "执行一个 JavaScript 风格的数学表达式，返回数值结果",
    schema: z.object({
      expression: z.string().describe("如 '4123 / 2810'"),
    }),
  },
);

export const agent = createAgent({
  model: deepseekModel,
  tools: [webSearch, calculator],
  systemPrompt: `你是一个研究分析助手。回答跟事实/数据有关的问题时，必须先用 web_search 获取信息，再用 calculator 做计算，最后给出简短结论。不要凭记忆回答。`,
});

export default async () => {
  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: "苹果 2025 财年的营收是微软的多少倍？",
        },
      ],
    },
    {
      streamMode: "updates",
    },
  );

  for await (const update of stream) {
    // update 形如 { 节点名: { messages: [...] } }
    for (const [nodeName, payload] of Object.entries(update)) {
      const messages = (payload as { messages?: unknown[] }).messages ?? [];
      for (const msg of messages as Array<Record<string, unknown>>) {
        // 模型节点：输出 thinking + tool_calls（createAgent 内部模型节点名是 "model_request"）
        if (nodeName === "model_request") {
          const toolCalls = msg.tool_calls as
            | Array<{ name: string; args: unknown }>
            | undefined;
          if (toolCalls?.length) {
            console.log(
              `[thought → action] ${toolCalls
                .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
                .join(", ")}`,
            );
          } else {
            // 没有工具调用，就是最终回答
            const text = extractText(msg.contentBlocks ?? msg.content);
            console.log(`[final answer] ${text}`);
          }
        }
        // 工具节点：输出 observation
        if (nodeName === "tools") {
          const text = extractText(msg.content);
          console.log(`[observation] ${text}`);
        }
      }
    }
  }

  // 兼容 1.x 多模态：contentBlocks 优先，回退到 content
  function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block: { type?: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : "",
        )
        .join("");
    }
    return "";
  }
};

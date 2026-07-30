// agent-with-multi-tools.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { deepseekModel } from "./model/index.js";
export default async () => {
  // 三个互相补充的工具
  const searchWeb = tool(
    async ({ query }) => {
      // 真实场景调 Tavily 或 SerpAPI
      return JSON.stringify({
        results: [
          { title: `${query} - 维基百科`, url: "https://example.com/1" },
          { title: `${query} - 官方文档`, url: "https://example.com/2" },
        ],
      });
    },
    {
      name: "web_search",
      description: "在互联网搜索最新信息。涉及实时数据、新闻、文档时使用。",
      schema: z.object({
        query: z.string().describe("搜索关键词"),
      }),
    },
  );

  const calculate = tool(
    async ({ expression }) => {
      try {
        return String(Function(`"use strict"; return (${expression})`)());
      } catch {
        return JSON.stringify({ error: "表达式无效" });
      }
    },
    {
      name: "calculate",
      description: "计算数学表达式。涉及数学运算时使用。",
      schema: z.object({
        expression: z.string().describe("JavaScript 兼容的数学表达式"),
      }),
    },
  );

  const getCurrentTime = tool(
    async ({ timezone }) => {
      const formatter = new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      });
      return formatter.format(new Date());
    },
    {
      name: "get_current_time",
      description: "获取指定时区的当前时间",
      schema: z.object({
        timezone: z
          .string()
          .default("Asia/Shanghai")
          .describe("IANA 时区，如 'Asia/Shanghai'、'America/New_York'"),
      }),
    },
  );

  // 一次 createAgent 调用，多工具并行
  const agent = createAgent({
    model: deepseekModel,
    tools: [searchWeb, calculate, getCurrentTime],
    systemPrompt:
      "你是一个高效的助手。涉及实时数据时必须调工具，不要凭记忆回答。回答简洁。",
  });

  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "现在纽约时间几点？另外，帮我搜一下 LangChain.js 1.x 最新特性，再算一下 0.3 * 2025 是多少",
      },
    ],
  });

  console.log(result.messages.at(-1)?.content);
};

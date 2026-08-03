// integrated-agent.ts
import { createAgent } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createRestTool } from "./rest-tool-factory.js";
import { SlidingWindowLimiter, withRateLimit } from "./rate-limiter.js";

// 1. 查询订单：REST + 认证 + 限流
const queryOrders = withRateLimit(
  createRestTool({
    name: "query_orders",
    description: "查询订单列表，可按状态过滤",
    schema: z.object({
      status: z
        .enum(["pending", "shipped", "completed", "cancelled"])
        .optional()
        .describe("订单状态过滤"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    baseURL: process.env.SHOP_API_BASE!,
    endpoint: "/orders",
    method: "GET",
    auth: { type: "bearer", token: process.env.SHOP_API_TOKEN! },
    buildQuery: (input) => ({
      status: input.status ?? "",
      limit: String(input.limit),
    }),
    timeout: 5000,
    maxRetries: 2,
  }),
  new SlidingWindowLimiter(30, 60000), // 每分钟 30 次
);

// 2. 库存查询：带降级的工厂
const checkInventory = createRestTool({
  name: "check_inventory",
  description: "查询商品库存状态",
  schema: z.object({
    productId: z.string().describe("商品 ID"),
  }),
  baseURL: process.env.INVENTORY_API_BASE!,
  endpoint: "/inventory/:id",
  method: "GET",
  auth: {
    type: "apiKey",
    header: "X-API-Key",
    key: process.env.INVENTORY_API_KEY!,
  },
  buildPath: ({ productId }) => `/inventory/${productId}`,
  timeout: 3000,
  maxRetries: 2,
  fallback: ({ productId }) =>
    JSON.stringify({
      success: false,
      error: "库存服务暂时不可用",
      hint: `请稍后查询 ${productId} 的库存，或联系运营手动处理`,
    }),
});

// 3. 业务告警：自定义 Tool
const sendAlert = tool(
  async ({ channel, message, priority }) => {
    // 真实场景调 Slack / 飞书 / 邮件 API
    console.log(`[${priority.toUpperCase()}] -> ${channel}: ${message}`);
    return JSON.stringify({
      success: true,
      channel,
      priority,
      sentAt: new Date().toISOString(),
    });
  },
  {
    name: "send_alert",
    description: "向运营团队发送告警",
    schema: z.object({
      channel: z.string().describe("Slack 频道，如 '#ops-alerts'"),
      message: z.string().describe("告警内容"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    }),
  },
);

// 4. 组装 Agent
const agent = createAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-6", temperature: 0 }),
  tools: [queryOrders, checkInventory, sendAlert],
  systemPrompt: `你是电商运营助手。可以查订单、查库存、发告警。
原则：
1. 发现低库存（< 10）或缺货时，必须向 #ops-alerts 发送 high 优先级告警
2. 告警内容要包含商品 ID 和当前库存数
3. 操作完成后简短总结结果`,
});

// 5. 跑一个真实任务
const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content:
        "查一下今天 pending 状态的订单，然后挑出涉及的商品检查库存，发现库存不足的发告警",
    },
  ],
});

console.log(result.messages.at(-1)?.content);

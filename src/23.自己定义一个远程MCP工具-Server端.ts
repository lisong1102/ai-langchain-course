/**
 * ============================================================================
 * 远程 MCP Server（服务端）- Streamable HTTP 模式
 * ============================================================================
 *
 * 【核心概念】
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                                                                     │
 * │  本文件 = MCP 工具的"提供方"（Server 端）                            │
 * │                                                                     │
 * │  与 22.ts（本地 stdio 版本）的区别：                                 │
 * │    - 22.ts: 通过 stdin/stdout 管道通信，只能本地使用                 │
 * │    - 本文件: 通过 HTTP 服务暴露，可以被远程访问                       │
 * │                                                                     │
 * │  使用场景：                                                         │
 * │    ✅ 部署到云服务器，团队成员共享使用                                │
 * │    ✅ 提供公开 API 给外部系统调用                                    │
 * │    ✅ 需要认证、权限控制的场景                                       │
 * │                                                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 【架构对比】
 *
 *   本地 stdio (22.ts)              远程 HTTP (本文件)
 *   ┌─────────────────┐          ┌─────────────────────────┐
 *   │  MCP Server     │          │   HTTP Server (Hono)    │
 *   │       ↓         │          │       ↓                 │
 *   │ StdioTransport  │          │ HTTP Transport          │
 *   │       ↓         │          │       ↓                 │
 *   │ stdin/stdout    │          │ port 3000               │
 *   └────────┬────────┘          └───────────┬─────────────┘
 *            ↓                               ↓
 *      只能本机进程访问                任何人通过 URL 访问
 *                                     http://localhost:3000/mcp
 *
 * 【执行流程】
 *
 *  Step 1: 定义 McpServer + 注册工具（和本地版完全一样）
 *  Step 2: 创建 Hono 应用 + 配置 CORS
 *  Step 3: 在 /mcp 路由中处理 MCP 协议请求
 *  Step 4: 启动 HTTP 服务，监听端口
 *  Step 5: 客户端通过 URL 连接并调用工具
 *
 * ============================================================================
 */

// ============================================================================
// 第一部分：导入依赖
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { z } from "zod";

// ============================================================================
// 第二部分：定义 MCP Server 和工具（和本地版逻辑完全相同！）
// ============================================================================

/**
 * 创建 MCP Server 实例
 *
 * 【重要】这里的定义和 22.ts 的本地版本一模一样！
 *        唯一的区别是最后"怎么暴露出去"
 */
const server = new McpServer({
  name: "my-remote-business-server",
  version: "1.0.0",
});

// ------------------------------------------------------------------
// 工具 1：查询订单状态
// ------------------------------------------------------------------
server.tool(
  "get_order_status",
  "查询订单状态，输入订单ID返回物流信息",
  {
    orderId: z.string().describe("订单 ID，例如 ORD-20240101-001"),
  },
  async ({ orderId }) => {
    // 真实场景这里会查数据库、调第三方物流API等
    const status = await queryOrderStatus(orderId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  },
);

// ------------------------------------------------------------------
// 工具 2：发送通知
// ------------------------------------------------------------------
server.tool(
  "send_notification",
  "向用户发送通知消息，支持邮件/短信/推送三种渠道",
  {
    userId: z.string().describe("用户 ID"),
    message: z.string().describe("通知内容"),
    channel: z.enum(["email", "sms", "push"]).describe("通知渠道"),
  },
  async ({ userId, message, channel }) => {
    // 真实场景这里会调用短信网关、邮件服务等
    await sendNotification(userId, message, channel);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              channel,
              userId,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ------------------------------------------------------------------
// 工具 3：数据统计（新增示例）
// ------------------------------------------------------------------
server.tool(
  "get_sales_statistics",
  "获取销售统计数据，支持按时间范围筛选",
  {
    startDate: z.string().describe("开始日期，格式 YYYY-MM-DD"),
    endDate: z.string().describe("结束日期，格式 YYYY-MM-DD"),
    category: z
      .optional(z.enum(["electronics", "clothing", "food", "all"]))
      .describe("商品类别，默认为 all"),
  },
  async ({ startDate, endDate, category = "all" }) => {
    const stats = await getSalesStatistics(startDate, endDate, category);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  },
);

// ============================================================================
// 第三部分：创建 HTTP 服务（关键差异点！）
// ============================================================================

/**
 * 创建 Hono Web 应用
 *
 * 【为什么用 Hono？】
 *   ✅ 轻量级、高性能
 *   ✅ 支持 Web Standard API（兼容 Node.js / Deno / Cloudflare Workers）
 *   ✅ 内置 TypeScript 支持
 *   ✅ MCP SDK 官方示例推荐
 */
const app = new Hono();

// ----------------------------------------------------------------------
// 配置 CORS（跨域资源共享）
// ----------------------------------------------------------------------
//
// 【什么是 CORS？】
//   当浏览器从前端页面发起跨域请求时，需要服务器明确允许。
//   这里配置允许所有来源访问（生产环境应该限制具体域名）。
//
app.use(
  "*",
  cors({
    origin: "*", // 允许所有来源（开发环境）
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], // 允许的 HTTP 方法
    allowHeaders: [
      "Content-Type",
      "mcp-session-id", // MCP 会话 ID（有状态模式需要）
      "Last-Event-ID", // SSE 重连时携带
      "mcp-protocol-version", // MCP 协议版本
    ],
    exposeHeaders: [
      "mcp-session-id", // 告诉客户端可以读取这个响应头
      "mcp-protocol-version",
    ],
  }),
);

// ----------------------------------------------------------------------
// 健康检查端点（可选但推荐）
// ----------------------------------------------------------------------
//
// 用于负载均衡器、Kubernetes 探针等检查服务是否存活
//
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "my-remote-business-mcp-server",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------
// 🔑 核心：MCP 协议端点
// ----------------------------------------------------------------------
//
// 【这里是关键！所有 MCP 协议请求都走这个路由】
//
// 【工作原理】
//   1. 收到 HTTP 请求（GET 或 POST 到 /mcp）
//   2. 创建新的 Transport 实例（无状态模式，每次请求新建）
//   3. 创建新的 Server 实例（或复用工厂函数）
//   4. 将 Server 连接到 Transport
//   5. 让 Transport 处理请求（解析 MCP 协议、路由到对应方法）
//   6. 返回响应
//
// 【两种模式说明】
//
//   📦 有状态模式（Stateful）：
//     - 维护会话状态，支持服务器主动推送通知
//     - 需要 mcp-session-id 来标识会话
//     - 适合需要长连接、实时推送的场景
//
//   📦 无状态模式（Stateful）【本示例采用】：
//     - 每次请求独立处理，不维护状态
//     - 更简单、更容易水平扩展
//     - 适合 RESTful 风格的工具调用
//
app.all("/mcp", async (c) => {
  // 创建新的 Transport 实例（无状态模式）
  //
  // 【为什么每次请求都 new？】
  //   无状态模式下，每个请求都是独立的，
  //   不需要在多个请求之间共享状态。
  //   这样可以轻松部署多个实例做负载均衡。
  const transport = new WebStandardStreamableHTTPServerTransport();

  // 连接 Server 到 Transport
  await server.connect(transport);

  // 让 Transport 处理请求（核心！）
  //
  // ╔═══════════════════════════════════════════════════════════════════╗
  // ║          Transport 的完整工作流程（协议适配器）                    ║
  // ╠═══════════════════════════════════════════════════════════════════╣
  // ║                                                                   ║
  // ║  📥 输入：HTTP Request（来自客户端）                               ║
  // ║    {                                                             ║
  // ║      "jsonrpc": "2.0",                                           ║
  // ║      "method": "tools/call",        ← 要调用的方法                ║
  // ║      "params": {                                                  ║
  // ║        "name": "get_order_status",  ← 工具名                     ║
  // ║        "arguments": { ... }         ← 参数                       ║
  // ║      }                                                            ║
  // ║    }                                                             ║
  // ║               ↓                                                   ║
  // ║  🔀 第一步：解析 & 路由                                            ║
  // ║    Transport 解析 JSON-RPC，根据 method 分发到不同处理逻辑：       ║
  // ║    ┌─────────────┬──────────────┬──────────────┬──────────────┐  ║
  // ║    │ initialize  │  tools/list  │  tools/call  │     ping      │  ║
  // ║    ↓             ↓              ↓              ↓              ║  ║
  // ║  返回服务器信息  返回工具列表    执行工具函数    返回 pong       ║
  // ║    └─────────────┴──────────────┴──────────────┴──────────────┘  ║
  // ║               ↓                                                   ║
  // ║  ⚙️ 第二步：调用 McpServer                                          ║
  // ║    以 tools/call 为例：                                             ║
  // ║    Transport 调用 server.callTool("get_order_status", {orderId})  ║
  // ║               ↓                                                   ║
  // ║  🛠 第三步：McpServer 执行工具函数                                   ║
  // ║    执行你定义的 async ({ orderId }) => { ... }                      ║
  // ║    返回原始结果: { content: [{ type: "text", text: "..." }] }     ║
  // ║               ↓                                                   ║
  // ║  📤 第四步：包装响应                                                ║
  // ║    Transport 把结果包装成 JSON-RPC 格式，通过 HTTP 返回给客户端      ║
  // ║    {                                                             ║
  // ║      "jsonrpc": "2.0",                                           ║
  // ║      "id": 1,                                                    ║
  // ║      "result": {                                                 ║
  // ║        "content": [{ "type": "text", "text": "..." }]            ║
  // ║      }                                                            ║
  // ║    }                                                             ║
  // ║                                                                   ║
  // ║  💡 简单理解：Transport = HTTP ↔ MCP 协议的双向翻译官              ║
  // ║                                                                   ║
  // ╚═══════════════════════════════════════════════════════════════════╝
  //
  return transport.handleRequest(c.req.raw);
});

// ============================================================================
// 第四部分：启动 HTTP 服务
// ============================================================================

const PORT = parseInt(process.env.MCP_PORT || "3000", 10);

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║        Remote MCP Server - Streamable HTTP Mode         ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  Service:    my-remote-business-server                  ║`);
console.log(`║  Version:    1.0.0                                      ║`);
console.log(`║  Transport:  Streamable HTTP                             ║`);
console.log(`╠══════════════════════════════════════════════════════════╣`);
console.log(`║  Health:     http://localhost:${PORT}/health}              ║`);
console.log(`║  MCP Endpoint: http://localhost:${PORT}/mcp                ║`);
console.log(`╚══════════════════════════════════════════════════════════╝`);

// 启动服务
serve({
  fetch: app.fetch,
  port: PORT,
}).then(() => {
  console.log(`\n🚀 MCP Server is running on port ${PORT}`);
  console.log(`\n📝 Clients can connect using:`);
  console.log(`   { "type": "url", "url": "http://localhost:${PORT}/mcp" }`);
  console.log(`\n🔧 Available tools:`);
  console.log(`   - get_order_status: 查询订单状态`);
  console.log(`   - send_notification: 发送通知`);
  console.log(`   - get_sales_statistics: 获取销售统计`);
  console.log("\n⚡  Press Ctrl+C to stop the server\n");
});

// ============================================================================
// 第五部分：模拟业务函数（真实项目中替换为真实的数据库/API 调用）
// ============================================================================

/**
 * 查询订单状态（模拟）
 *
 * 真实场景可能：
 * - 查询 MySQL/PostgreSQL 数据库
 * - 调用顺丰/圆通等物流 API
 * - 查询 Redis 缓存
 */
async function queryOrderStatus(orderId: string) {
  // 模拟网络延迟
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 模拟不同订单的不同状态
  const statuses = ["pending", "processing", "shipped", "delivered"];
  const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];

  return {
    orderId,
    status: randomStatus,
    // 根据状态返回不同的详细信息
    ...(randomStatus === "shipped" && {
      carrier: "顺丰速运",
      trackingNumber: `SF${Date.now()}`,
      estimatedDelivery: "2024-01-05",
    }),
    ...(randomStatus === "delivered" && {
      carrier: "顺丰速运",
      trackingNumber: `SF${Date.now()}`,
      deliveredAt: "2024-01-03T14:30:00Z",
      signedBy: "本人签收",
    }),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 发送通知（模拟）
 *
 * 真实场景可能：
 * - 调用阿里云短信服务
 * - 调用 SendGrid/阿里云邮件服务
 * - 调用极光推送/个推
 */
async function sendNotification(
  _userId: string,
  _message: string,
  channel: string,
) {
  // 模拟网络延迟
  await new Promise((resolve) => setTimeout(resolve, 50));

  console.log(
    `[${new Date().toISOString()}] 📤 Notification sent via ${channel} to user`,
  );

  // 真实实现：
  // switch (channel) {
  //   case "sms":
  //     await smsService.send(userId, message);
  //     break;
  //   case "email":
  //     await emailService.send(userId, message);
  //     break;
  //   case "push":
  //     await pushService.send(userId, message);
  //     break;
  // }
}

/**
 * 获取销售统计（模拟）
 *
 * 真实场景可能：
 * - 聚合查询 MongoDB/ClickHouse
 * - 调用 BI 系统接口
 * - 从 Elasticsearch 聚合
 */
async function getSalesStatistics(
  startDate: string,
  endDate: string,
  category: string,
) {
  // 模拟计算
  await new Promise((resolve) => setTimeout(resolve, 150));

  return {
    period: { startDate, endDate },
    category,
    totalRevenue: Math.floor(Math.random() * 1000000) / 100,
    totalOrders: Math.floor(Math.random() * 1000) + 100,
    averageOrderValue: Math.floor(Math.random() * 1000) + 50,
    topProducts: [
      { name: "商品A", sales: Math.floor(Math.random() * 500) },
      { name: "商品B", sales: Math.floor(Math.random() * 400) },
      { name: "商品C", sales: Math.floor(Math.random() * 300) },
    ],
    generatedAt: new Date().toISOString(),
  };
}

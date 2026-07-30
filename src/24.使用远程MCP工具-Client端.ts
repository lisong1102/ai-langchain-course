/**
 * ============================================================================
 * 远程 MCP Client（客户端）- 连接远程 MCP Server
 * ============================================================================
 *
 * 【核心概念】
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                                                                     │
 * │  本文件 = MCP 工具的"使用方"（Client 端）                            │
 * │                                                                     │
 * │  对应的服务端：23.自己定义一个远程MCP工具-Server端.ts                │
 * │                                                                     │
 * │  与 21.ts（本地 stdio 客户端）的区别：                               │
 * │    - 21.ts: 启动子进程，通过 stdin/stdout 通信                       │
 * │    - 本文件: 通过 HTTP URL 连接远程服务                              │
 * │                                                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 【架构图】
 *
 *   你的应用 (Client)              远程服务器 (Server - 23.ts)
 *   ┌─────────────────┐          ┌─────────────────────────┐
 *   │                 │          │                         │
 *   │ MultiServerMCP  │  HTTP    │   Hono + MCP Server     │
 *   │ Client          │ ←───→   │   (端口 3000)           │
 *   │                 │  JSON-RPC│                         │
 *   │                 │          │                         │
 *   └────────┬────────┘          └─────────────────────────┘
 *            ↓
 *      获取 LangChain Tool 对象
 *            ↓
 *         Agent 使用
 *
 * 【通信流程】
 *
 *   1️⃣ 建立连接
 *       POST http://server:3000/mcp
 *       {"jsonrpc":"2.0","id":0,"method":"initialize","params":{...}}
 *
 *   2️⃣ 获取工具列表
 *       POST http://server:3000/mcp
 *       {"jsonrpc":"2.0","id":1,"method":"tools/list"}
 *       → 返回: get_order_status, send_notification, get_sales_statistics
 *
 *   3️⃣ 调用工具（Agent 决定调用时）
 *       POST http://server:3000/mcp
 *       {"jsonrpc":"2.0","id":2,"method":"tools/call",
 *        "params":{"name":"get_order_status","arguments":{"orderId":"ORD-001"}}}
 *
 * ============================================================================
 */

// ============================================================================
// 导入依赖
// ============================================================================

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";
import { deepseekModel } from "./model/index.js";

// ============================================================================
// 主函数
// ============================================================================

export default async () => {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        Remote MCP Client Example                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ==========================================================================
  // 第一步：创建 MCP 客户端（关键差异点！）
  // ==========================================================================
  //
  // 【与本地版本的核心区别】
  //
  //   本地版本 (21.ts):
  //     transport: "stdio",
  //     command: "npx",           // 启动子进程
  //     args: ["-y", "..."]      // 子进程参数
  //
  //   远程版本 (本文件):
  //     type: "url",             // 使用 URL 连接
  //     url: "http://..."        // 远程服务地址
  //

  const client = new MultiServerMCPClient({
    mcpServers: {
      // 👇 服务器名称（自定义标识）
      "remote-business": {
        // 👇 关键：使用 URL 类型而不是 stdio！
        type: "url",

        // 👇 远程 MCP Server 的地址
        //    这就是 23.ts 启动后监听的地址
        url: "http://localhost:3000/mcp",

        // 👇 可选：自定义请求头（用于认证等）
        headers: {
          // "Authorization": "Bearer your-token-here",
          // "X-API-Key": "your-api-key",
        },
      },

      // 💡 提示：可以同时连接多个远程服务！
      // "another-service": {
      //   type: "url",
      //   url: "https://other-server.com/mcp",
      // },
    },
  });

  try {
    // ==========================================================================
    // 第二步：获取工具（自动建立连接）
    // ==========================================================================
    //
    // 【内部发生了什么？】
    //
    // 1️⃣ 发送 HTTP POST 到 http://localhost:3000/mcp
    //    请求体：{"jsonrpc":"2.0","id":0,"method":"initialize",...}
    //
    // 2️⃣ 收到响应：服务器信息、协议版本、能力列表
    //
    // 3️⃣ 发送 tools/list 请求
    //
    // 4️⃣ 收到工具列表：
    //    [
    //      {
    //        name: "get_order_status",
    //        description: "查询订单状态...",
    //        inputSchema: { orderId: { type: "string" } }
    //      },
    //      // ... 更多工具
    //    ]
    //
    // 5️⃣ 将每个 MCP 工具转换为 LangChain Tool 对象
    //    工具名会变成: "remote-business_get_order_status"
    //    （前缀是服务器名，避免命名冲突）
    //

    console.log("📡 Connecting to remote MCP Server...");
    const tools = await client.getTools();

    console.log(`✅ Connected! Loaded ${tools.length} tools:\n`);
    tools.forEach((tool, index) => {
      console.log(`   ${index + 1}. ${tool.name}`);
      console.log(`      ${tool.description.slice(0, 60)}...`);
      console.log("");
    });

    // ==========================================================================
    // 第三步：创建 Agent 并绑定工具
    // ==========================================================================

    const agent = createAgent({
      model: deepseekModel,
      tools, // 👈 从远程 MCP 获取的工具（和本地工具用法完全一样！）
      systemPrompt: `你是一个业务助手，可以使用以下远程工具：
        - 查询订单状态
        - 发送通知
        - 获取销售统计

请根据用户需求选择合适的工具。`,
    });

    // ==========================================================================
    // 第四步：测试调用
    // ==========================================================================

    console.log("=" .repeat(60));
    console.log("🧪 Test 1: 查询订单状态");
    console.log("=".repeat(60));

    const result1 = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "请查询订单 ORD-20240101-001 的当前状态",
        },
      ],
    });

    console.log("\n📝 Agent 回复:");
    console.log(result1.messages.at(-1)?.content);
    console.log("\n");

    // ------------------------------------------------------------------
    console.log("=" .repeat(60));
    console.log("🧪 Test 2: 获取销售统计");
    console.log("=".repeat(60));

    const result2 = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "帮我查一下 2024年1月 所有品类的销售数据",
        },
      ],
    });

    console.log("\n📝 Agent 回复:");
    console.log(result2.messages.at(-1)?.content);
    console.log("\n");

    // ------------------------------------------------------------------
    console.log("=" .repeat(60));
    console.log("🧪 Test 3: 组合操作");
    console.log("=".repeat(60));

    const result3 = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "先查询订单 ORD-20240115-002 的状态，然后给用户 user_123 发一条短信通知他订单已发货",
        },
      ],
    });

    console.log("\n📝 Agent 回复:");
    console.log(result3.messages.at(-1)?.content);
    console.log("\n");
  } catch (error) {
    console.error("❌ Error:", error);
    console.log("\n💡 请确保先启动服务端：");
    console.log("   npx tsx src/23.自己定义一个远程MCP工具-Server端.ts");
  } finally {
    // ==========================================================================
    // 第五步：关闭连接
    // ==========================================================================
    //
    // 【注意】与本地版本不同：
    //   - 本地版本：关闭子进程
    //   - 远程版本：关闭 HTTP 连接（服务端继续运行）
    //
    await client.close();
    console.log("🔌 Connection closed");
  }
};

// ============================================================================
// 使用说明
// ============================================================================
//
// 🚀 启动步骤：
//
// Terminal 1 - 启动服务端（23.ts）:
//   npx tsx src/23.自己定义一个远程MCP工具-Server端.ts
//   → 输出: MCP Server is running on port 3000
//
// Terminal 2 - 启动客户端（本文件）:
//   npx tsx src/24.使用远程MCP工具-Client端.ts
//   → 自动连接到 localhost:3000 并执行测试
//
// 🔥 生产部署：
//
// 1. 将 23.ts 构建成 Docker 镜像
// 2. 部署到云服务器（AWS / 阿里云 / K8s）
// 3. 修改本文件的 url 为实际地址:
//    url: "https://your-domain.com/mcp"
// 4. 配置 HTTPS + 认证（见 23.ts 的 CORS 和 headers 配置）
//
// ============================================================================

// ===================定义MCP==========================================
// my-mcp-server.ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-business-server",
  version: "1.0.0",
});

// 注册一个工具
server.tool(
  "get_order_status",
  "查询订单状态",
  {
    orderId: z.string().describe("订单 ID"),
  },
  async ({ orderId }) => {
    // 真实场景查数据库
    const status = await queryOrderStatus(orderId);
    return {
      content: [{ type: "text", text: JSON.stringify(status) }],
    };
  },
);

server.tool(
  "send_notification",
  "向用户发送通知",
  {
    userId: z.string(),
    message: z.string(),
    channel: z.enum(["email", "sms", "push"]),
  },
  async ({ userId, message, channel }) => {
    await sendNotification(userId, message, channel);
    return {
      content: [
        { type: "text", text: JSON.stringify({ success: true, channel }) },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// 假函数，演示用
async function queryOrderStatus(id: string) {
  return { orderId: id, status: "shipped", carrier: "顺丰" };
}
async function sendNotification(uid: string, msg: string, ch: string) {}

//==========================使用自定义MCP=============================================

// langchain使用mcp
const client = new MultiServerMCPClient({
  mcpServers: {
    "my-business": {
      transport: "stdio",
      command: "npx",
      args: ["tsx", "./my-mcp-server.ts"],
    },
  },
});

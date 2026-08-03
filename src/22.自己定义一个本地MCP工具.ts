import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";
import { deepseekModel } from "./model/index.js";

export default async () => {
  // langchain使用mcp
  const client = new MultiServerMCPClient({
    mcpServers: {
      "my-business": {
        transport: "stdio",
        command: "npx",
        args: ["tsx", "./src/mcp/my-mcp-server.ts"],
      },
    },
  });

  //获取mcp提供的工具
  const tools = await client.getTools();

  //模型使用
  const agent = createAgent({
    model: deepseekModel,
    tools,
    systemPrompt: "你是一个订单查询助手，和信息发送助手",
  });
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: "你查询一下订单 123456 的订单状态，并向用户张三发送邮件通知",
      },
    ],
  });
  console.log(result.messages.at(-1)?.content);
};

// buffer-demo.ts
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { deepseekModel } from "./model/index.js";
export default async () => {
  //第一种创建agent模型的方式：
  // 1.直接输入格式: "provider:model-name"
  //2.前提：需要安装 @langchain/deepseek 包，并设置环境变量 DEEPSEEK_API_KEY
  //   const agent = createAgent({
  //     model: "deepseek:deepseek-v4-flash",
  //     tools: [],
  //     systemPrompt: "你是一个简洁的助手，会记住用户提过的信息。",
  //     checkpointer: new MemorySaver(),
  //   });

  //第二种直接传入一个模型实例
  const agent = createAgent({
    model: deepseekModel,
    tools: [],
    systemPrompt: "你是一个简洁的助手，会记住用户提过的信息。",
    checkpointer: new MemorySaver(), //本地环境缓存
  });

  const config = { configurable: { thread_id: "demo-thread-1" } };

  await agent.invoke(
    { messages: [{ role: "user", content: "我叫张三，今年 28" }] },
    config,
  );

  const r = await agent.invoke(
    { messages: [{ role: "user", content: "我多大了？" }] },
    config,
  );

  console.log(r.messages.at(-1)?.content);
  // → "你 28 岁。"
};

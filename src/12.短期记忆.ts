import { createAgent, createMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { trimMessages } from "@langchain/core/messages";
import readline from "node:readline";
import { deepseekModel } from "./model/index.js";

/**
 * 🔑 短期记忆（Sliding Window）示例
 *
 * 核心概念：
 * 1. 【滑动窗口】trimMessages — 只保留最近 N 条消息，超出部分丢弃
 *    类似「金鱼记忆」，只记得最近的一段对话，更早的会被裁掉
 *
 * 2. 【持久化记忆】MemorySaver + thread_id — 把所有对话历史存到内存中
 *    类似「笔记本」，每次对话都记下来，下次还能翻看
 *
 * 💡 两者的区别：
 *    - 滑动窗口：控制「发给模型看多少内容」（省钱、防溢出）
 *    - 持久化记忆：控制「对话历史存不存在」（跨轮次记住上下文）
 *
 * 📌 典型场景：客服机器人、聊天助手——需要短期上下文，但不需要长期记忆
 */
export default async () => {
  // ═══════════════════════════════════════════════════════════════
  // 第一步：创建消息裁剪器（滑动窗口）
  // ═══════════════════════════════════════════════════════════════
  // 作用：当消息总 token 数超过 maxTokens 时，自动裁剪掉旧消息
  // 只保留最近的对话内容，防止 context window 爆掉
  const trimmer = trimMessages({
    maxTokens: 3000, // 🎯 窗口大小：最多保留 3000 token 的消息
    strategy: "last", // 裁剪策略：保留「最后」N 条，旧的丢掉
    tokenCounter: (msgs) =>
      msgs.reduce(
        (s, m) => s + (typeof m.text === "string" ? m.text.length / 3 : 0),
        0,
      ),
    includeSystem: true, // ✅ 始终保留 system prompt，不被裁剪
    startOn: "human", // 从「人类」消息开始计数（保证用户问题完整）
  });

  // ═══════════════════════════════════════════════════════════════
  // 第二步：创建中间件，把裁剪器挂载到 agent 的生命周期中
  // ═══════════════════════════════════════════════════════════════
  // beforeModel 钩子：在消息发送给模型「之前」，先执行裁剪
  // 这样模型永远只会看到最近的消息，不会因为太长而报错
  const windowMw = createMiddleware({
    name: "window",
    beforeModel: async (state) => ({
      messages: await trimmer.invoke(state.messages), // 👈 在这里执行裁剪！
    }),
  });

  // ═══════════════════════════════════════════════════════════════
  // 第三步：创建带记忆的 Agent
  // ═══════════════════════════════════════════════════════════════
  const agent = createAgent({
    model: deepseekModel,
    tools: [],
    systemPrompt: "你是一个友好的中文助手。回答尽量简短。",
    middleware: [windowMw], // 👈 挂载滑动窗口中间件
    checkpointer: new MemorySaver(), // 👈 持久化记忆：把所有消息存到内存
  });
  //
  // 🧠 记忆工作流程：
  //   用户输入 → 存入 MemorySaver → beforeModel 触发裁剪 → 只保留最近 3000 token → 发给模型
  //
  // ⚠️ 注意：MemorySaver 存的是「完整历史」，trimmer 决定的是「模型能看到多少」
  //     即使旧消息被裁剪了，它们仍然保存在 MemorySaver 中！

  // ═══════════════════════════════════════════════════════════════
  // 第四步：配置会话 ID（thread_id 是记忆的「钥匙」）
  // ═══════════════════════════════════════════════════════════════
  // CLI 对话循环，所有对话都在同一个 thread
  //
  // 🔑 thread_id 的作用：
  //   - 相同 thread_id → 共享同一份记忆（能记住之前的对话）
  //   - 不同 thread_id → 完全独立的对话（互不干扰）
  //   - 类比：thread_id 就像是聊天室的「房间号」
  const config = { configurable: { thread_id: "cli-session" } };

  // ═══════════════════════════════════════════════════════════════
  // 第五步：创建命令行交互界面
  // ═══════════════════════════════════════════════════════════════
  // 创建命令行输入输出接口
  const rl = readline.createInterface({
    input: process.stdin, // 键盘输入流
    output: process.stdout, // 屏幕输出流
  });

  // 把回调式的 rl.question 包装成 Promise，方便用 await
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  // ═══════════════════════════════════════════════════════════════
  // 第六步：主对话循环
  // ═══════════════════════════════════════════════════════════════
  console.log("输入 quit 退出\n");
  while (true) {
    const input = (await ask("你: ")).trim();
    if (input === "quit") break;

    // 每次调用 agent.invoke() 时：
    // 1. 新消息追加到 MemorySaver 的历史记录中
    // 2. beforeModel 中间件触发，对完整历史执行裁剪
    // 3. 只有裁剪后的消息（最近 ~3000 token）被发送给模型
    // 4. 模型的回复也会存入 MemorySaver
    const res = await agent.invoke(
      { messages: [{ role: "user", content: input }] },
      config, // 👈 同一个 config = 同一个 thread_id = 共享记忆
    );

    // 取最后一条消息（就是 AI 的回复）
    const last = res.messages.at(-1);
    console.log(`AI: ${last?.text ?? ""}\n`);
  }
  rl.close();
};

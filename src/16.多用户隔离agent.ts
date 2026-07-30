/**
 * ============================================================================
 * 模块 16：多用户隔离 Agent
 * ============================================================================
 *
 * 【核心概念】
 * 本示例展示如何构建一个支持多用户的 Agent，实现两种记忆机制：
 *
 * 1. 短期记忆（Checkpointer）- 由 PostgresSaver 管理
 *    - 作用：保存完整对话历史，让 Agent "记得刚才聊了什么"
 *    - 类比：浏览器的"历史记录" + "标签页状态"
 *    - 按 thread_id 隔离，同一用户不同会话独立
 *
 * 2. 长期记忆（Store）- 由 InMemoryStore 管理
 *    - 作用：保存用户主动透露的关键信息，跨会话持久化
 *    - 类比：手机的"通讯录" / "备忘录"
 *    - 按 user_id 隔离，不同用户数据完全隔离
 *
 * 【架构图】
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    多用户 Agent 架构                        │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │   ┌──────────────────┐    ┌──────────────────────────────┐  │
 * │   │   PostgresSaver   │    │     InMemoryStore            │  │
 * │   │   (checkpointer)  │    │     (store)                  │  │
 * │   ├──────────────────┤    ├──────────────────────────────┤  │
 * │   │ 职责：保存对话状态  │    │ 职责：保存用户长期记忆         │  │
 * │   │ - 完整消息历史      │    │ - rememberFact 存的事实       │  │
 * │   │ - Agent 内部状态    │    │ - 结构化 key-value 数据       │  │
 * │   │ - 可恢复断点续传     │    │ - 跨会话/跨线程持久化         │  │
 * │   └──────────────────┘    └──────────────────────────────┘  │
 * │          ↓                            ↓                     │
 * │   PostgreSQL 数据库           内存（生产环境可换 PostgreSQL）  │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 【数据隔离示意】
 * PostgresSaver: thread_id="alice-conv-1" → Alice 的对话 A
 *                thread_id="alice-conv-2" → Alice 的对话 B（新会话）
 *                thread_id="bob-conv-1"   → Bob 的对话
 *
 * InMemoryStore: ["alice", "facts"] → { fact: "Alice 是 iOS 开发者" }
 *                ["bob", "facts"]   → { fact: "Bob 是产品经理" }
 *                （Bob 无法访问 Alice 的记忆，反之亦然）
 *
 * 【生产环境配置】
 * 开发环境：MemorySaver + InMemoryStore（零配置，重启丢失）
 * 测试环境：SqliteSaver + InMemoryStore（轻量持久化）
 * 生产环境：PostgresSaver + PostgresStore（高可用、多实例共享）
 *
 * Checkpointer 是 LangGraph 内置的标准实现，只需配好数据库连接，
 * 剩下的建表、读写、版本管理全部自动处理，无需手动干预。
 * ============================================================================
 */

// ============================================================================
// 1. 导入依赖
// ============================================================================

import { createAgent } from "langchain";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"; // PostgreSQL 检查点存储（短期记忆）
import { InMemoryStore } from "@langchain/langgraph"; // 内存键值存储（长期记忆）
import { tool } from "@langchain/core/tools"; // 工具定义装饰器
import { z } from "zod"; // Schema 定义库
import { deepseekModel } from "./model/index.js"; // DeepSeek AI 模型

export default async () => {
  // ==========================================================================
  // 2. 初始化短期记忆存储（Checkpointer）
  // ==========================================================================
  //
  // PostgresSaver 负责：
  // - 自动在 PostgreSQL 中创建 checkpoints 和 checkpoint_blobs 表
  // - 每次 agent.invoke() 时自动保存/读取对话状态
  // - 支持按 thread_id 隔离不同会话的对话历史
  // - 支持断点续传（通过 checkpoint_id 恢复到历史状态）
  //
  // 存储内容：
  // {
  //   thread_id: "alice-conv-1",
  //   messages: [/* 完整对话消息历史 */],
  //   agentState: { /* Agent 当前内部状态 */ }
  // }
  //
  // 注意：这里使用 PostgreSQL，也可以替换为：
  // - MemorySaver：纯内存，适合开发测试（重启丢失）
  // - SqliteSaver：SQLite 文件，适合单机轻量应用
  // ==========================================================================

  const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup(); // ← 首次运行时自动创建表结构，后续调用幂等

  // ==========================================================================
  // 3. 初始化长期记忆存储（Store）
  // ==========================================================================
  //
  // InMemoryStore 是一个简单的键值数据库，用于存储结构化的用户信息。
  // 它的数据模型是三层结构：namespace → key → value
  //
  // 数据组织方式：
  // store
  // └── ["alice", "facts"]        ← namespace（命名空间，用于用户隔离）
  //     ├── "fact-1722078900000"  ← key（唯一标识，这里用时间戳）
  //     │   └── { fact: "Alice 是 iOS 开发者" }  ← value（实际数据）
  //     └── "fact-1722079000000"
  //         └── { fact: "Alice 使用 Swift 和 SwiftUI" }
  //
  // 生产环境建议替换为 PostgresStore 实现持久化
  // ==========================================================================

  const store = new InMemoryStore(); // TODO: 生产环境换 PostgresStore

  // ==========================================================================
  // 4. 定义工具：remember_fact（记住事实）
  // ==========================================================================
  //
  // 这个工具让 Agent 能够主动记住用户透露的关键信息。
  //
  // 工作流程：
  // 用户说："我是 Alice，iOS 开发者"
  //         ↓
  // AI 分析对话，判断这是需要记住的关键信息
  //         ↓
  // AI 自动调用此工具：remember_fact(fact="Alice 是 iOS 开发者")
  //         ↓
  // 工具将信息存入 InMemoryStore，返回确认消息
  //
  // 关键点：
  // - fact 参数不是原始对话，而是 AI 提取/总结后的结构化信息
  // - AI 会根据 description 自主判断什么信息值得记住
  // - 用户完全无感，AI 在后台自动调用
  // ==========================================================================

  const rememberFact = tool(
    async ({ fact }, runtime) => {
      // 从 runtime.context 获取当前用户 ID
      // 这个 user_id 是在调用 agent.invoke() 时通过 context 传入的
      const userId = runtime.context.user_id as string;
      if (!userId) throw new Error("缺少 user_id");

      // 存储到 InMemoryStore
      // namespace: [userId, "facts"] → 按用户隔离，Bob 无法访问 Alice 的数据
      // key: `fact-${Date.now()}` → 用时间戳生成唯一 ID，每条记录独立
      // value: { fact } → 实际存储的内容
      await store.put([userId, "facts"], `fact-${Date.now()}`, { fact });

      return `已记住：${fact}`;
    },
    {
      name: "remember_fact",
      // description 非常重要！AI 根据这个描述决定何时调用工具
      description: "记下用户的关键信息（身份、偏好、决定）",
      schema: z.object({
        fact: z.string(), // AI 提取后的关键信息，如 "Alice 是 iOS 开发者"
      }),
    },
  );

  // ==========================================================================
  // 5. 定义工具：recall_facts（回忆事实）
  // ==========================================================================
  //
  // 这个工具让 Agent 能够检索之前记住的用户信息。
  //
  // 使用场景：
  // 用户问："你还记得我的技术背景吗？"
  //         ↓
  // AI 调用此工具：recall_facts(query="技术背景")
  //         ↓
  // 工具从 InMemoryStore 中搜索当前用户的记忆并返回
  //         ↓
  // AI 基于检索结果回答用户问题
  //
  // 安全性：
  // - 只搜索 [userId, "facts"] 命名空间下的数据
  // - 不同用户之间完全隔离，无法互相访问
  // ==========================================================================

  const recallFacts = tool(
    async ({ query }, runtime) => {
      const userId = runtime.context.user_id as string;

      // 搜索当前用户的记忆，最多返回 5 条
      // query 参数目前未用于精确匹配，实际返回最新的 N 条记录
      // 如需实现语义搜索，可结合向量数据库
      const items = await store.search([userId, "facts"], { limit: 5 });

      // 将所有事实拼接成文本返回给 AI
      return items.map((i) => i.value.fact).join("\n") || "（没有相关记忆）";
    },
    {
      name: "recall_facts",
      description: "检索当前用户曾经透露过的关键事实",
      schema: z.object({
        query: z.string(), // 搜索关键词（可选，用于未来扩展语义搜索）
      }),
    },
  );

  // ==========================================================================
  // 6. 创建 Agent
  // ==========================================================================
  //
  // createAgent 是 LangChain 的高级 API，封装了 ReAct 循环：
  // 思考(Reason) → 行动(Act) → 观察(Observe) → 循环直到完成
  //
  // 配置说明：
  // - model: 使用的 LLM（这里是 DeepSeek）
  // - tools: Agent 可以调用的工具列表
  // - systemPrompt: 系统提示词，指导 Agent 行为
  // - checkpointer: 短期记忆存储（管理对话历史）
  // - store: 长期记忆存储（管理用户档案）
  // ==========================================================================

  const agent = createAgent({
    model: deepseekModel,
    tools: [rememberFact, recallFacts],
    systemPrompt:
      "你是一个会主动记忆和回忆的助手。不要凭印象，靠工具拿事实。",
    checkpointer,
    store,
  });

  // ==========================================================================
  // 7. 封装聊天函数
  // ==========================================================================
  //
  // chatAs 函数封装了 agent.invoke() 调用，提供三个维度的隔离：
  //
  // - userId: 用户身份标识 → 用于 Store 隔离（长期记忆）
  //   不同用户有不同的 ["userId", "facts"] 命名空间
  //
  // - threadId: 会话标识 → 用于 Checkpointer 隔离（短期记忆）
  //   同一用户可以有多个会话（thread），每个会话有独立的对话历史
  //
  // - content: 用户消息内容
  // ==========================================================================

  async function chatAs(
    userId: string,
    threadId: string,
    content: string,
  ) {
    return agent.invoke(
      { messages: [{ role: "user", content }] },
      {
        configurable: { thread_id: threadId }, // 控制 Checkpointer（短期记忆）
        context: { user_id: userId }, // 控制 Store（长期记忆）
      },
    );
  }

  // ==========================================================================
  // 8. 演示场景
  // ==========================================================================

  // --- 场景 1：Alice 的第一个会话 ---
  // Alice 介绍自己，Agent 会自动调用 remember_fact 记住她的信息

  await chatAs("alice", "alice-conv-1", "我是 Alice，iOS 开发者");
  // → Agent 可能调用: remember_fact(fact="Alice 是 iOS 开发者")

  await chatAs("alice", "alice-conv-1", "我用 Swift 和 SwiftUI");
  // → Agent 可能调用: remember_fact(fact="Alice 使用 Swift 和 SwiftUI 进行开发")
  // → 此时 InMemoryStore 中有 2 条关于 Alice 的记忆

  // --- 场景 2：Bob 的会话（验证用户隔离）---
  // Bob 问是否知道其他用户的信息，应该无法访问 Alice 的数据

  await chatAs("bob", "bob-conv-1", "我是 Bob，产品经理");
  await chatAs("bob", "bob-conv-1", "你知道其他用户做什么吗？");
  // → Agent 调用: recall_facts(user_id="bob")
  // → 只能找到 Bob 自己的记忆，返回空或 Bob 的信息
  // → 回答："不知道其他用户的信息"（因为 namespace 隔离）

  // --- 场景 3：Alice 的新会话（验证跨会话长期记忆）---
  // Alice 换了一个新的 threadId，但 userId 不变
  // - 短期记忆（Checkpointer）：新的 threadId 意味着全新的对话上下文
  // - 长期记忆（Store）：userId 不变，所以能检索到之前的记忆

  const data = await chatAs("alice", "alice-conv-2", "总结一下我的技术背景");
  console.log("总结结果：" + data.messages.at(-1)?.text);
  // → Agent 调用: recall_facts(user_id="alice")
  // → 找到之前记住的 iOS / Swift / SwiftUI 信息
  // → 回答："你是 iOS 开发者，使用 Swift 和 SwiftUI..."
};

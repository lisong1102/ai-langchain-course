import { createAgent, tool } from "langchain";
import { InMemoryStore } from "@langchain/langgraph";
import { OpenAIEmbeddings } from "@langchain/openai";
import { z } from "zod";
import { deepseekModel } from "./model/index.js";
import { FakeEmbeddings } from "@langchain/core/utils/testing";

/**
 * Store 语义召回示例
 *
 * 核心概念：
 * - InMemoryStore 内部维护两份数据：this.data（原始键值）+ this.vectors（向量索引）
 * - put 时：自动用 embedding 模型把 fields 指定的字段 → 向量，两份一起存
 * - search 时：先从 data 按 namespace 过滤出候选，再用 embedding 对 query 向量化，
 *            然后和候选的预存向量算余弦相似度，按 score 排序返回原始数据
 * - 不加 embedding：退化为纯键值库，search 只能做 namespace 过滤 + 分页，无语义排序
 *
 * tool 函数第二个参数命名约定：
 * - 参数名写 config  → 类型是 RunnableConfig，只有 configurable/tags 等基础字段
 * - 参数名写 runtime → 类型是 ToolRuntime，拥有 store/context/state/toolCallId/writer 等 agent 运行时信息
 */
export default async () => {
  // 创建带向量索引的内存 Store
  const store = new InMemoryStore({
    index: {
      dims: 1536, // embedding 向量维度，需与 embeddings 模型输出一致
      embeddings: new FakeEmbeddings({
        size: 1536, // 模拟 OpenAI text-embedding-3-small 的维度（生产环境换真实模型）
      }),
      fields: ["text"], // 指定对 value 的哪些字段做 embedding（支持嵌套路径如 "metadata.title"）
    },
  });

  // 工具：记住一条用户信息
  // put 时 Store 内部会自动：提取 value.text → 调 embedding 模型生成向量 → 存入 vectors 索引
  const saveMemory = tool(
    async ({ text }, runtime) => {
      // 第二个参数必须命名为 runtime（不是 config），才能获得 ToolRuntime 类型
      // runtime.context 来自 createAgent 调用时传入的 { context: { userId: "u-123" } }
      const userId = runtime.context.userId;
      // runtime.store 就是上面创建的 InMemoryStore 实例（通过 createAgent({ store }) 注入）
      await runtime.store?.put(["memories", userId], crypto.randomUUID(), {
        text,
      });
      return "已记住";
    },
    {
      name: "save_memory",
      description: "当用户透露了值得长期记住的偏好/事实时调用",
      schema: z.object({ text: z.string().describe("要记住的一句话") }),
    },
  );

  // 工具：检索相关记忆（语义召回）
  // search 时 Store 内部会自动：
  //   ① 从 data Map 按 namespacePrefix 过滤出所有候选 item（纯键值操作）
  //   ② 用 embedding 模型把 query 文本 → 向量
  //   ③ 取每个候选在 put 时预存的向量，和 query 向量算余弦相似度
  //   ④ 按相似度从高到低排序，返回原始 value 数据 + score 分数
  const recallMemory = tool(
    async ({ query }, runtime) => {
      const userId = runtime.context.userId;
      // search 返回的是按语义相关性排好序的结果，直接取 value.text 即可
      const hits = await runtime.store?.search(["memories", userId], {
        query, // 有 query 才会触发向量相似度排序；不加 query 则退化为普通过滤+分页
        limit: 3, // 返回最相关的 top 3 条
      });
      return (
        (hits ?? []).map((h) => h.value.text).join("\n") || "（没有相关记忆）"
      );
    },
    {
      name: "recall_memory",
      description: "回答前先检索这个用户的历史偏好/事实",
      schema: z.object({ query: z.string() }),
    },
  );

  const agent = createAgent({
    model: deepseekModel,
    tools: [saveMemory, recallMemory],
    systemPrompt:
      "回答前先用 recall_memory 查用户偏好；用户透露新信息时用 save_memory 记下。",
    store, // 注入 Store 后，工具函数中通过 runtime.store 即可访问
  });

  // 第 1 轮：存入记忆 "对花生过敏" → 自动 embedding 后存入 data + vectors
  // ⚠️ 必须 await！否则 agent 还没来得及调用 save_memory 工具就进入下一轮了
  await agent.invoke(
    { messages: [{ role: "user", content: "用户对花生过敏" }] },
    { context: { userId: "u-123" } }, // 通过 context 注入 userId，实现多用户隔离
  );
  // 第 2 轮：存入记忆 "喜欢川菜" → 同样自动 embedding
  await agent.invoke(
    { messages: [{ role: "user", content: "用户喜欢川菜" }] },
    { context: { userId: "u-123" } },
  );
  // 第 3 轮：问 "推荐个菜谱" → agent 先调用 recall_memory 做语义搜索
  //   query 会匹配到 "喜欢川菜"（相关度高）和 "对花生过敏"（中等相关）
  //   然后结合这些记忆给出推荐（比如推荐川菜但提醒避开花生）
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "推荐个菜谱" }] },
    { context: { userId: "u-123" } },
  );
  console.log("回复：" + result.messages.at(-1)?.text);
};

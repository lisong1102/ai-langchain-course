// memory-tool.ts
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export default async () => {
  const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });
  const vectorStore = new MemoryVectorStore(embeddings);

  // 工具 1：检索历史
  const recallMemory = tool(
    async ({ query }) => {
      const docs = await vectorStore.similaritySearch(query, 3);
      if (docs.length === 0) return "（没有找到相关的历史信息）";
      return docs.map((d, i) => `[${i + 1}] ${d.pageContent}`).join("\n");
    },
    {
      name: "recall_memory",
      description:
        "在用户的长期记忆里检索与当前问题语义相关的片段。当用户提到自己之前说过的内容、或问题涉及用户个人偏好/背景时调用。",
      schema: z.object({
        query: z.string().describe("要检索的关键词或问题，越具体越好"),
      }),
    },
  );

  // 工具 2：把值得长期记住的事实写入记忆
  const saveMemory = tool(
    async ({ fact }) => {
      await vectorStore.addDocuments([
        new Document({
          pageContent: fact,
          metadata: { timestamp: Date.now() },
        }),
      ]);
      return `已记忆：${fact}`;
    },
    {
      name: "save_memory",
      description:
        "把用户主动透露的、值得长期记住的事实写入记忆。例如姓名、职业、偏好、关键决定。寒暄和临时信息不要写入。",
      schema: z.object({
        fact: z.string().describe("一句话事实，不要带语气词"),
      }),
    },
  );

  const agent = createAgent({
    model: "anthropic:claude-sonnet-4-6",
    tools: [recallMemory, saveMemory],
    systemPrompt: `你是一个有长期记忆的助手。
- 用户透露身份、偏好等信息时，主动调 save_memory 记下来
- 用户的问题涉及他过去说过的内容时，先调 recall_memory 检索
- 不要凭印象回答，靠工具拿事实`,
    checkpointer: new MemorySaver(),
  });

  const config = { configurable: { thread_id: "demo" } };

  await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: "我叫李华，在上海做全栈，主要用 React + Node",
        },
      ],
    },
    config,
  );

  await agent.invoke(
    { messages: [{ role: "user", content: "我周末喜欢跑步和看科幻小说" }] },
    config,
  );

  // 100 轮后……
  const r = await agent.invoke(
    { messages: [{ role: "user", content: "推荐一本适合我的技术书" }] },
    config,
  );
  console.log(r.messages.at(-1)?.text);
  // Agent 会先调 recall_memory("用户的技术背景") → 拿到"React + Node + 全栈"
  // 然后给出针对性建议
};

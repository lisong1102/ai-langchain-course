// translation-pipeline.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableLambda,
  RunnableParallel,
  RunnableSequence,
} from "@langchain/core/runnables";
import { z } from "zod";
import { deepseekModel as model } from "./model/index.js";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { OutputFunctionsParser } from "@langchain/core/output_parsers/openai_functions";
export default async () => {
  // 三个独立的数据源（生产环境替换成真实实现）
  // 这里的参数只会接受一个任意类型。这里用new和RunnableLambda、from的方式都可以
  const searchDocs = new RunnableLambda({
    func: async (input: { query: string }) => [
      `[Docs] 关于 ${input.query} 的文档片段...`,
    ],
  });

  const searchWeb = new RunnableLambda({
    func: async (query: string) => [`[Web] 关于 ${query} 的最新信息...`],
  });

  const searchDB = new RunnableLambda({
    func: async (query: string) => [`[DB] ${query} 相关的结构化数据...`],
  });

  //并发处理。推荐用from的形式
  const multiSourceSearch = RunnableParallel.from({
    docs: searchDocs,
    web: searchWeb,
    db: searchDB,
  });

  //主链：检索 → 合并上下文 → 生成回答
  const qaChain = RunnablePassthrough.assign({
    resource: async (input: { question: string }) => {
      return await multiSourceSearch.invoke(input.question);
    },
  })
    .pipe(
      (input: {
        question: string;
        resource: { docs: string[]; web: string[]; db: string[] };
      }) => ({
        question: input.question,
        context: [
          ...input.resource.docs,
          ...input.resource.web,
          ...input.resource.db,
        ].join("\n"),
      }),
    )
    .pipe(
      ChatPromptTemplate.fromTemplate(
        `基于以下信息回答用户问题。

参考信息：
{context}

用户问题：{question}

请给出准确、全面的回答：`,
      ),
    )
    .pipe(model)
    .pipe(new StringOutputParser());

  const answer = await qaChain.invoke({ question: "LangChain 是什么？" });
  console.log(answer);
};

// 注意点=====================
// 1.和 RunnablePassthrough.assign() 的差别
// 初学最容易搞混的就是这两个，它们都能产出多字段对象，差别在于”要不要保留原始输入”：

// 维度	RunnableParallel	RunnablePassthrough.assign()
// 原始输入	不保留，输出只含定义的字段	保留，并追加新字段
// 典型用途	从零构建输出对象	在已有数据上增量添加字段
// 链中位置	通常是终点或分叉点	通常在链中段做”数据增厚”

// 2.错误处理：默认是 Promise.all 语义
// 任何一个分支抛异常，整个 parallel 失败，其他分支已经算出来的结果会被丢弃

// 要让某个分支失败不影响整体，给它单独挂 fallback：
// import { RunnableLambda } from "@langchain/core/runnables";

// const riskyBranch = new RunnableLambda({
//   func: async () => fetchExternalAPI(),
// }).withFallbacks([
//   // 失败时返回降级结果而不是抛异常
//   new RunnableLambda({ func: () => ({ error: "数据源暂不可用" }) }),
// ]);

// const resilient = new RunnableParallel({
//   safe: safeChain,
//   risky: riskyBranch,
// });
// .withFallbacks([...]) 的细节在 Fallback 与重试 里展开。

// 3.并发数控制
// RunnableParallel 默认让所有分支同时启动，不做限流。分支多到几十个、每个又都调外部 API 时，得自己控制。最简单的办法是用 p-limit：

// import pLimit from "p-limit";
// import { RunnableLambda, RunnableParallel } from "@langchain/core/runnables";

// const limit = pLimit(3); // 最多 3 个并发

// const controlled = new RunnableParallel({
//   a: new RunnableLambda({ func: (i) => limit(() => chainA.invoke(i)) }),
//   b: new RunnableLambda({ func: (i) => limit(() => chainB.invoke(i)) }),
//   c: new RunnableLambda({ func: (i) => limit(() => chainC.invoke(i)) }),
//   d: new RunnableLambda({ func: (i) => limit(() => chainD.invoke(i)) }),
// });
// batch() 的外层也有并发控制，两层并发会叠乘：

// // 10 条文本各跑一次分析，每条内部 3 个并发分支
// // 理论峰值并发 = 10 × 3 = 30 次 LLM 调用
// await analysisChain.batch(tenTexts, { maxConcurrency: 5 });
// // 外层限到 5，所以实际峰值 = 5 × 3 = 15

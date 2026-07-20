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
  const searchDocs = new RunnableLambda({
    func: async (query: string) => [`[Docs] 关于 ${query} 的文档片段...`],
  });

  const searchWeb = new RunnableLambda({
    func: async (query: string) => [`[Web] 关于 ${query} 的最新信息...`],
  });

  const searchDB = new RunnableLambda({
    func: async (query: string) => [`[DB] ${query} 相关的结构化数据...`],
  });

  //并发处理
  const multiSourceSearch = new RunnableParallel({
    steps: {
      docs: searchDocs,
      web: searchWeb,
      db: searchDB,
    },
  });

  //主链：检索 → 合并上下文 → 生成回答
  const qaChain = RunnablePassthrough.assign({
    resource: (input: { question: string }) => {
      multiSourceSearch.invoke({
        query: input.question,
      });
    },
  })
    .pipe((input) => ({
      question: input.question,
      context: [
        ...input.resource.docs,
        ...input.resource.web,
        ...input.resource.db,
      ].join("\n"),
    }))
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
    .pipe(new OutputFunctionsParser());

  const answer = await qaChain.invoke({ question: "LangChain 是什么？" });
  console.log(answer);
};

// intent-router.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableBranch,
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";
import { deepseekModel } from "./model/index.js";
export default async () => {
  // 分类用速度档（Haiku 4.5 / GPT-4o-mini），各处理链可以用更强的模型,但这里就统一用deepseek了
  const classifier = deepseekModel;
  const responder = deepseekModel;
  const parser = new StringOutputParser();

  // 意图分类子链
  const classifyIntent = ChatPromptTemplate.fromTemplate(
    `将以下用户消息分类为：question / complaint / feedback / other。
只返回意图名称，不要其他内容。
 
用户消息：{message}`,
  )
    .pipe(classifier)
    .pipe(parser)
    .pipe((intent: string) => intent.trim().toLowerCase());

  // 四条处理链
  const questionChain = ChatPromptTemplate.fromTemplate(
    "用户提出了一个问题，请专业、详细地回答：\n{message}",
  )
    .pipe(responder)
    .pipe(parser);

  const complaintChain = ChatPromptTemplate.fromTemplate(
    "用户提出了投诉，请先表达歉意和理解，再提供解决方案：\n{message}",
  )
    .pipe(responder)
    .pipe(parser);

  const feedbackChain = ChatPromptTemplate.fromTemplate(
    "用户提供了反馈，请表达感谢并说明我们会如何处理：\n{message}",
  )
    .pipe(responder)
    .pipe(parser);

  const otherChain = ChatPromptTemplate.fromTemplate(
    "请友好地回应用户：\n{message}",
  )
    .pipe(responder)
    .pipe(parser);

  // 主链：分类 + 路由
  const routerChain = RunnableSequence.from([
    // 第一步：保留原始输入，同时附加 intent 字段
    RunnablePassthrough.assign({
      intent: (input: { message: string }) =>
        classifyIntent.invoke({ message: input.message }),
    }),
    // 第二步：按 intent 路由
    RunnableBranch.from([
      [
        (input: { message: string; intent: string }) =>
          input.intent === "question",
        questionChain,
      ],
      [(input) => input.intent === "complaint", complaintChain],
      [(input) => input.intent === "feedback", feedbackChain],
      otherChain,
    ]),
  ]);

  // 测试
  const responses = await Promise.all([
    routerChain.invoke({ message: "你们的 API 响应时间为什么这么慢？" }),
    routerChain.invoke({ message: "LangChain 支持哪些向量数据库？" }),
    routerChain.invoke({ message: "建议增加对 Milvus 的原生支持" }),
  ]);
  responses.forEach((r, i) => console.log(`#${i + 1}: ${r}\n`));
};

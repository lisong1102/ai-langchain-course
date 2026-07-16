import { RunnablePassthrough } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "langchain";

// RunnablePassthrough.assign 的工作方式是：
// 保留原始输入的所有字段
// 额外添加你 assign 的新字段answer
export default async () => {
  // 选择你有 API Key 的 Provider，注释掉另一个
  const model = new ChatOpenAI({
    model: "deepseek-v4-flash", // DeepSeek 支持的模型：deepseek-v4-pro 或 deepseek-v4-flash
    configuration: {
      baseURL: "https://api.deepseek.com",
      apiKey: process.env.OPENAI_API_KEY,
    },
    temperature: 0,
  });

  const chain = RunnablePassthrough.assign({
    answer: async (input) => {
      const res = await model.invoke([
        {
          role: "user",
          content: `${input.context}\n\n问题：${input.question}`,
        },
      ]);
      return res.text;
    },
  });

  const result = await chain.invoke({
    question: "什么是react",
    context: "react",
  });

  console.log("模型回复1111111：" + result.answer);
};

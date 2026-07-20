import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { deepseekModel as model } from "./model/index.js";

export default async () => {
  // 1. 模板定义
  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `你是 {domain} 领域的技术顾问。
回答风格：
- 先给出简短结论
- 再展开详细解释
- 最后给出实践建议
 
当前日期：{date}`,
    ],
    // Few-shot 示例（可选）
    ["placeholder", "{examples}"],
    // 历史对话
    ["placeholder", "{history}"],
    // 当前输入
    ["human", "{input}"],
  ]);

  // 2. 预绑定静态/动态变量
  const boundPrompt = await prompt.partial({
    date: () => new Date().toLocaleDateString("zh-CN"),
    domain: "云原生",
  });

  // 3. 组成完整链
  const chain = boundPrompt.pipe(model).pipe(new StringOutputParser());

  // 4. 调用
  const answer = await chain.invoke({
    examples: [
      new HumanMessage("Kubernetes 和 Docker 有什么区别？"),
      new AIMessage(
        "结论：Docker 是容器运行时，Kubernetes 是容器编排平台。\n\n详细解释：Docker 负责创建和运行单个容器...\n\n实践建议：先掌握 Docker 基础，再上手 Kubernetes。",
      ),
    ],
    history: [
      new HumanMessage("我想学习微服务架构"),
      new AIMessage("微服务是现代后端的主流模式之一..."),
    ],
    input: "微服务之间如何通信？",
  });

  console.log(answer);
};

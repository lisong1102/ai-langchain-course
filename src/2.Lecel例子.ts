import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableLambda,
  RunnablePassthrough,
  RunnableParallel,
} from "@langchain/core/runnables";
import { z } from "zod";
import { deepseekModel as model } from "./model/index.js";

export default async () => {
  // 1. 翻译子链
  const translatePrompt = ChatPromptTemplate.fromMessages([
    ["system", "将用户输入翻译为 {language}，只输出译文。"],
    ["human", "{text}"],
  ]);
  const translateChain = translatePrompt
    .pipe(model)
    .pipe(new StringOutputParser());

  // 2. 结构化分析子链（withStructuredOutput 在 Output Parsers 一节会讲）
  const analysisSchema = z.object({
    topics: z.array(z.string()).describe("主题标签"),
    difficulty: z.enum(["easy", "medium", "hard"]).describe("难度"),
  });

  // 注意：DeepSeek v4 的 thinking 模式不支持 tool_choice（functionCalling 需要）
  // 所以这里使用 jsonMode 方法代替，prompt 需要包含 "json" 关键词
  const analysisChain = ChatPromptTemplate.fromMessages([
    [
      "system",
      `分析文本的主题和难度。请严格按照以下 JSON schema 输出：
- topics: 主题标签数组（字符串数组）
- difficulty: 难度等级，只能是 "easy"、"medium" 或 "hard"

示例输出格式：{{"topics": ["AI", "机器学习"], "difficulty": "medium"}}`,
    ],
    ["human", "{text}"],
  ]).pipe(model.withStructuredOutput(analysisSchema, { method: "jsonMode" }));

  // 3. 并行：同时翻译两种语言 + 分析 + 透传原文
  // RunnableParallel.from(...)（等价于 new RunnableParallel({ steps: ... }) 构造）
  // 会把同一个输入对象广播给每个分支：english/japanese 分支需要 language 字段，
  // 所以用 assign 加上；analysis 分支只需要 text，原始输入已经满足，不需要再 assign。
  const combined = RunnableParallel.from({
    english: RunnablePassthrough.assign({ language: () => "English" }).pipe(
      translateChain,
    ),
    japanese: RunnablePassthrough.assign({ language: () => "Japanese" }).pipe(
      translateChain,
    ),
    analysis: analysisChain,
    original: RunnableLambda.from((input: { text: string }) => input.text),
  });

  // 4. 格式化输出
  const formatOutput = RunnableLambda.from(
    (input: {
      english: string;
      japanese: string;
      analysis: z.infer<typeof analysisSchema>;
      original: string;
    }) =>
      [
        `原文: ${input.original}`,
        `英文: ${input.english}`,
        `日文: ${input.japanese}`,
        `主题: ${input.analysis.topics.join(", ")}`,
        `难度: ${input.analysis.difficulty}`,
      ].join("\n"),
  );

  const fullChain = combined.pipe(formatOutput);

  const result = await fullChain.invoke({
    text: "大语言模型通过自注意力机制捕获序列中的长距离依赖关系。",
  });

  console.log(result);
  // 原文: 大语言模型通过自注意力机制捕获序列中的长距离依赖关系。
  // 英文: Large language models capture long-range dependencies in sequences via self-attention.
  // 日文: 大規模言語モデルは自己注意機構を通じてシーケンス内の長距離依存関係を捕捉します。
  // 主题: LLM, Self-Attention, Deep Learning
  // 难度: hard
};

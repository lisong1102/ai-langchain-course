// translation-pipeline.ts
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { z } from "zod";
import { deepseekModel as model } from "./model/index.js";

const parser = new StringOutputParser();

// 子链 1：检测语言
const detectLang = ChatPromptTemplate.fromTemplate(
  "检测以下文本是什么语言，只返回语言名称（English / 中文 / 日本語 ...）：\n{text}",
)
  .pipe(model)
  .pipe(parser);

// 子链 2：翻译
const translate = ChatPromptTemplate.fromTemplate(
  "把以下 {sourceLang} 文本翻译成 {targetLang}，保持原文风格：\n{text}",
)
  .pipe(model)
  .pipe(parser);

// 子链 3：质量评估（结构化输出）
const qualitySchema = z.object({
  score: z.number().min(1).max(10),
  suggestions: z.array(z.string()),
});
const qualityCheck = ChatPromptTemplate.fromTemplate(
  `对比原文和译文，给出 1-10 分和改进建议。
原文（{sourceLang}）：{text}
译文（{targetLang}）：{translation}`,
).pipe(
  model.withStructuredOutput(qualitySchema, { method: "functionCalling" }),
);

// 主链：把三个子链按顺序串起来，每步都把中间结果合并回输入
const pipeline = RunnableSequence.from([
  async (input: { text: string; targetLang: string }) => ({
    ...input,
    sourceLang: (await detectLang.invoke({ text: input.text })).trim(),
  }),
  async (input) => ({
    ...input,
    translation: await translate.invoke(input),
  }),
  async (input) => ({
    originalText: input.text,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    translation: input.translation,
    quality: await qualityCheck.invoke(input),
  }),
]);

const result = await pipeline.invoke({
  text: "The quick brown fox jumps over the lazy dog.",
  targetLang: "中文",
});

console.log(result);
// {
//   originalText: "The quick brown fox jumps over the lazy dog.",
//   sourceLang: "English",
//   targetLang: "中文",
//   translation: "敏捷的棕色狐狸跳过了那只懒狗。",
//   quality: { score: 8, suggestions: ["可以考虑更文学化的表达"] },
// }

// 性能注意点
// 1.流式输出：RunnableSequence 原生支持 .stream()，但只有最后一步是真正流式的，中间步骤会等上一步完整产出。具体哪些节点会阻断流，下一节 Streaming 流式输出 会专门讲。
// 2.批量处理：chain.batch([input1, input2, ...], { maxConcurrency: 5 }) 可以对多输入并发跑同一条链，充分利用模型 API 的并发额度。注意 maxConcurrency 是顶层 config 字段，直接传给 RunnableConfig，不要再嵌到 batchOptions 里。
// 3.调试：给关键节点加 runName 和 tags，在 LangSmith trace 里会方便很多。

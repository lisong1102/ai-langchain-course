import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { deepseekModel as model } from "./model/index.js";

export default async () => {
  // 1. 定义 schema
  const articleAnalysisSchema = z.object({
    title: z.string().describe("文章标题"),
    category: z
      .enum([
        "technology",
        "business",
        "science",
        "politics",
        "sports",
        "other",
      ])
      .describe("文章分类"),
    keyPoints: z.array(z.string()).min(1).max(5).describe("核心要点，1-5 条"),
    entities: z
      .array(
        z.object({
          name: z.string().describe("实体名称"),
          type: z
            .enum(["person", "organization", "location", "product"])
            .describe("实体类型"),
        }),
      )
      .describe("提到的关键实体"),
    sentiment: z
      .enum(["positive", "negative", "neutral"])
      .describe("文章整体基调"),
    readingTimeMinutes: z.number().describe("预估阅读时间（分钟）"),
  });

  type ArticleAnalysis = z.infer<typeof articleAnalysisSchema>;

  // 2. 构建链
  const structuredModel = model.withStructuredOutput(articleAnalysisSchema, {
    method: "functionCalling",
    includeRaw: false,
  });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "你是新闻分析助手，请仔细阅读文章并提取结构化信息。"],
    ["human", "请分析以下文章：\n\n{article}"],
  ]);

  const analysisChain = prompt.pipe(structuredModel);

  // 3. 调用
  const analysis: ArticleAnalysis = await analysisChain.invoke({
    article: `
    苹果公司今日在加州库比蒂诺总部举行发布会，正式推出搭载 M4 芯片的
    新一代 MacBook Pro。CEO 蒂姆·库克表示，新款笔记本在 AI 推理性能上
    相比上一代提升了 3 倍。新品起售价 1599 美元，将于下周五正式发售。
    分析师认为这将进一步巩固苹果在高端笔记本市场的领先地位。
  `,
  });

  console.log(JSON.stringify(analysis, null, 2));
  // {
  //   "title": "苹果发布搭载 M4 芯片的新一代 MacBook Pro",
  //   "category": "technology",
  //   "keyPoints": [
  //     "苹果推出搭载 M4 芯片的新 MacBook Pro",
  //     "AI 推理性能提升 3 倍",
  //     "起售价 1599 美元，下周五发售"
  //   ],
  //   "entities": [
  //     { "name": "苹果公司", "type": "organization" },
  //     { "name": "蒂姆·库克", "type": "person" },
  //     { "name": "库比蒂诺", "type": "location" },
  //     { "name": "MacBook Pro", "type": "product" },
  //     { "name": "M4 芯片", "type": "product" }
  //   ],
  //   "sentiment": "positive",
  //   "readingTimeMinutes": 1
  // }
};

//支持批量输入处理
// const articles = [article1, article2, article3];

// const results = await analysisChain.batch(
//   articles.map((article) => ({ article })),
//   { maxConcurrency: 3 }  //最大并发数量
// );

// deepseek v4 思考模式下暂不支持tool_choice（functionCalling 需要）

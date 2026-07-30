import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda } from "@langchain/core/runnables";
import { ChatPromptTemplate } from "@langchain/core/prompts";
// import RunnablePassthroughDemo from "./1-RunnablePassthrough.js";
// import demo2 from "./2.Lecel例子.js";
// import demo3 from "./3.PromptTemplates例子.js";
// import demo4 from "./4.OutputParsers例子.js";
// import demo5 from './5.translation-pipeline顺序链例子'
// import demo6 from "./6.RunnableParallel 并行链.js";
// import demo7 from "./7.RunnableBranch先分类在回复.js";
// import demo9 from "./9.流式stream和streamEvents.js";
// import demo10 from "./10.Fallback与重试.js";
// import demo11 from "./11.第一个有记忆的agent.js";
// import demo12 from "./12.短期记忆.js";
// import demo13 from "./13.middleware压缩历史.js";
// import demo14 from "./14.agent自己去记忆vectorStore.js";
// import demo16 from "./16.多用户隔离agent.js";
// import demo17 from "./17.store语义召回.js";
// import demo18 from "./18.Tool 接口与定义.js";
// import demo20 from "./20.模型并行调用工具.js";
import demo21 from "./21.McpServer工具使用.js";
// import demo23 from "./23.自己定义一个远程MCP工具-Server端.js";  // 服务端：先启动这个
// import demo24 from "./24.使用远程MCP工具-Client端.js";          // 客户端：再启动这个
// ============================================
// 1. 基础调用：直接调用模型
// ============================================
async function basicInvoke() {
  console.log("=== 基础调用 ===\n");
  // 选择你有 API Key 的 Provider，注释掉另一个
  const model = new ChatOpenAI({
    model: "deepseek-v4-flash", // DeepSeek 支持的模型：deepseek-v4-pro 或 deepseek-v4-flash
    configuration: {
      baseURL: "https://api.deepseek.com",
      apiKey: process.env.OPENAI_API_KEY,
    },
    temperature: 0,
  });

  // 如果你使用 Anthropic，取消下面的注释：
  // const model = new ChatAnthropic({
  //   model: "claude-haiku-4-5",
  //   temperature: 0,
  // });

  const response = await model.invoke([
    new SystemMessage("你是一个乐于助人的 AI 助手。请用中文回答。"),
    new HumanMessage("用一句话解释什么是 LangChain。"),
  ]);

  // 1.x 推荐用 response.text 取纯文本，多模态场景读 response.contentBlocks
  console.log("模型回复:", response.text);
  console.log("Token 使用:", response.usage_metadata);
  console.log();
}

// ============================================
// 2. 流式输出：逐 Token 打印
// ============================================
async function streamOutput() {
  console.log("=== 流式输出 ===\n");

  const model = new ChatOpenAI({
    model: "deepseek-v4-flash", // DeepSeek 支持的模型
    configuration: {
      baseURL: "https://api.deepseek.com",
      apiKey: process.env.OPENAI_API_KEY,
    },
    temperature: 0.7,
  });

  const stream = await model.stream([
    new HumanMessage("写一首关于编程的四行诗。"),
  ]);

  process.stdout.write("模型回复: ");
  for await (const chunk of stream) {
    process.stdout.write(chunk.text ?? "");
  }
  console.log("\n");
}

// ============================================
// 3. Chain 组合：模型 + 输出解析器
// ============================================
const wordCounter = RunnableLambda.from((text: string) => {
  return {
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    charCount: text.length,
  };
});
async function chainExample() {
  console.log("=== Chain 组合 ===\n");
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "你是翻译助手，把中文翻译成 {language}，只输出译文。"],
    ["human", "{text}"],
  ]);
  const model = new ChatOpenAI({
    model: "deepseek-v4-flash", // DeepSeek 支持的模型
    configuration: {
      baseURL: "https://api.deepseek.com",
      apiKey: process.env.OPENAI_API_KEY,
    },
    temperature: 0,
  });

  // 使用 pipe() 将模型和输出解析器连接成 Chain
  const chain = prompt
    .pipe(model)
    .pipe(new StringOutputParser())
    .pipe(wordCounter);

  // invoke 的返回值直接是 string，不再是 AIMessage
  const result = await chain.invoke({
    language: "英文",
    text: "今天天气真好",
  });

  console.log("解析后的结果:", result);
  console.log("结果类型:", typeof result);
  console.log();
}

// ============================================
// 运行所有示例
// ============================================
async function main() {
  console.log("LangChain.js 环境验证\n");

  try {
    // await basicInvoke();
    // await streamOutput();
    // await chainExample();
    // RunnablePassthroughDemo();
    // demo2();
    // demo3();
    // demo4();
    //demo5();
    // demo6();
    // demo7();
    // demo9();
    // demo10();
    // demo11();
    // demo12();
    // demo13();
    // demo14();
    // demo16();
    // demo17();
    // demo18();
    // demo20();
    demo21();
    console.log("[OK] 所有验证通过，环境已准备就绪。");
  } catch (error) {
    console.error("[FAIL] 验证失败:", error);
    console.error("\n请检查：");
    console.error("1. .env 文件是否存在且包含正确的 API Key");
    console.error("2. API Key 是否有效且有足够额度");
    console.error("3. 网络是否能访问 API 服务");
    process.exit(1);
  }
}

main();

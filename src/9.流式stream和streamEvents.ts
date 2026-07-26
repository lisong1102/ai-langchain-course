// streamEvents：流式事件的"上帝视角"
// stream() 只能拿到最终输出，streamEvents 能看到链路中发生的每件事：
// - on_chat_model_stream: 模型逐 token 输出
// - on_chain_start / on_chain_end: 链的开始和结束
// - on_parser_start / on_parser_end: 解析器的开始和结束
// 适合调试、展示进度、或对中间结果做特殊处理

import { StringOutputParser } from "@langchain/core/output_parsers";
import { deepseekModel } from "./model/index.js";
import { ChatPromptTemplate } from "@langchain/core/prompts";

export default async () => {
  const prompt = ChatPromptTemplate.fromTemplate(
    "用通俗易懂的语言解释概念：{concept}，控制在 100 字以内。",
  );
  const model = deepseekModel;

  const chain = prompt.pipe(model).pipe(new StringOutputParser());

  const eventStream = chain.streamEvents(
    { concept: "量子纠缠" },
    { version: "v2" }, // v2 是当前稳定版本，必填
  );

  console.log("=== streamEvents 流式事件演示 ===\n");
  console.log("模型回复: ");

  for await (const event of eventStream) {
    switch (event.event) {
      case "on_chat_model_stream": {
        // 模型吐出的每个 token
        const chunk = event.data.chunk; // AIMessageChunk

        // 兼容两种格式：
        // - contentBlocks: LangChain 1.x 多模态新格式（Anthropic / 部分新版 OpenAI）
        // - content: 传统字符串格式（DeepSeek / 大多数 OpenAI 兼容模型）
        let text = "";

        if (chunk.contentBlocks?.length) {
          // 新格式：从 contentBlocks 提取文本
          text = chunk.contentBlocks
            .filter((b: { type: string; text?: string }) => b.type === "text")
            .map((b: { type: string; text?: string }) => b.text ?? "")
            .join("");
        } else if (typeof chunk.content === "string") {
          // 传统格式：content 直接是字符串
          text = chunk.content;
        } else if (Array.isArray(chunk.content)) {
          // 有些模型的 content 是数组形式
          text = chunk.content
            .filter(
              (b: { type: string; text?: string }) =>
                b.type === "text" && typeof b.text === "string",
            )
            .map((b: { type: string; text?: string }) => b.text)
            .join("");
        }

        process.stdout.write(text);
        break;
      }
      case "on_chain_start":
        console.log(`\n🚀 [链启动] ${event.name}`);
        break;
      case "on_chain_end":
        console.log(`\n✅ [链结束] ${event.name}`);
        break;
      case "on_parser_start":
        console.log(`\n📝 [解析器启动] ${event.name}`);
        break;
      case "on_parser_end":
        console.log(`\n📦 [解析器结束] ${event.name}`);
        break;
      // 可以忽略的事件（减少噪音）
      // case "on_chat_model_start":
      // case "on_chat_model_end":
      //   break;
    }
  }

  console.log("\n\n=== 流式事件结束 ===");
};

//重要点
// 1.stream()：最常用的流
// 2.某些情况流式会被阻断
// -结构化输出（要等完整 JSON 才能 parse）
// -普通 RunnableLambda（函数签名 (input) => output，必须等完整 input）
// -工具调用（要等完整参数才能执行）
// 3..streamEvents()：拿到链里的每一个事件
// 4.让 lambda 保持流式：func 返回 async generator
// 5.可以控制事件是否处理，第三个参数里面添加过滤条件
// const eventStream = chain.streamEvents(
//   input,
//   { version: "v2" },
//   {
//     // 只听这些 name 的节点
//     includeNames: ["MainModel"],
//     // 或者按 tag 过滤
//     includeTags: ["important"],
//     // 或者按类型过滤
//     includeTypes: ["chat_model"],
//   },
// );

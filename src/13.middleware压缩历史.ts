// support-bot.ts
// ============================================
// 【核心概念】Middleware 历史压缩（History Compression）
//
// 问题背景：
// LLM 的上下文窗口是有限的，随着对话越来越长：
// 1. Token 消耗越来越大 → 成本增加
// 2. 超出上下文窗口限制 → 报错或截断
// 3. 长上下文可能导致模型"遗忘"早期重要信息
//
// 解决方案：使用 Middleware 在每次调用模型前自动压缩历史消息
// - 当消息数达到阈值时，将旧消息摘要化并删除
// - 将摘要作为 SystemMessage 注入，保持上下文连贯性
// ============================================

import { createAgent, createMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";
import { deepseekModel } from "./model/index.js";
import {
  BaseMessage,
  SystemMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import { z } from "zod";
export default async () => {
  // ========== 压缩策略配置 ==========

  // TRIGGER: 触发压缩的消息数量阈值
  // 当历史消息数 >= 16 条时，开始执行压缩
  const TRIGGER = 16;

  // KEEP: 压缩后保留的最新消息数量
  // 保留最近 6 条消息不压缩，确保对话的即时上下文完整
  const KEEP = 6;

  // ========== 摘要生成函数 ==========

  /**
   * 构建对话摘要
   * @param toCompress - 需要被压缩的历史消息数组
   * @param oldSummary - 上一次的摘要内容（用于增量摘要）
   * @returns 压缩后的摘要文本
   *
   * 工作原理：
   * 1. 将消息数组转换为文本格式
   * 2. 调用 LLM 生成结构化摘要（客户身份、解决方案、情绪、未解决事项）
   * 3. 支持增量摘要：将旧摘要一并传入，LLM 会合并新旧信息
   */
  async function buildSummary(toCompress: BaseMessage[], oldSummary: string) {
    // 将消息对象转换为可读文本：格式为 "消息类型: 消息内容"
    const dialog = toCompress
      .map((m) => `${m.getType()}: ${typeof m.text === "string" ? m.text : ""}`)
      .join("\n");

    // 调用 LLM 生成摘要，Prompt 包含：
    // - 角色定义：客服对话摘要器
    // - 输出格式要求：结构化摘要
    // - 旧摘要：用于增量更新
    // - 新对话内容：需要压缩的消息
    const res = await deepseekModel.invoke([
      new SystemMessage(
        `你是客服对话摘要器。压缩下面对话，按以下结构输出：
- 客户身份与诉求
- 已提供的解决方案
- 客户情绪
- 未解决事项
 
旧摘要：${oldSummary || "（无）"}
 
新对话：
${dialog}`,
      ),
    ]);
    return typeof res.text === "string" ? res.text : "";
  }

  // ========== 创建 Middleware ==========

  /**
   * 创建历史压缩中间件
   *
   * Middleware 是 LangChain 中的拦截器机制，可以在模型调用前后执行自定义逻辑
   *
   * 核心配置：
   * - name: 中间件名称，用于调试和日志
   * - stateSchema: 定义中间件维护的状态结构（这里用 summary 字段存储摘要）
   * - beforeModel: 在每次调用模型前执行的钩子函数
   */
  const summaryMw = createMiddleware({
    name: "summary",

    // 定义中间件的私有状态，使用 Zod schema 进行类型安全校验
    // summary 字段存储最新的对话摘要，默认为空字符串
    //这里定义了哪些规则，就可以返回那些字段
    stateSchema: z.object({ summary: z.string().default("") }),

    /**
     * beforeModel 钩子 - 在模型调用前执行
     * @param state - 当前 agent 的完整状态（包含 messages、summary 等）
     * @returns 需要更新的状态字段（messages 和/或 summary）
     *
     * 执行流程：
     * 1. 检查消息数量是否达到压缩阈值
     * 2. 计算需要压缩的消息范围
     * 3. 调用 buildSummary 生成摘要
     * 4. 返回操作指令：
     *    - RemoveMessage: 删除已被摘要覆盖的旧消息
     *    - SystemMessage: 插入摘要作为新的系统消息
     */
    beforeModel: async (state) => {
      const msgs = state.messages as BaseMessage[];

      // 消息数未达阈值，跳过压缩，直接返回
      if (msgs.length < TRIGGER) return;

      // 计算切割点：总消息数 - 保留数量 = 需要压缩的消息数
      const cut = msgs.length - KEEP;

      // 取出需要被压缩的旧消息（从第1条到切割点）
      const toCompress = msgs.slice(0, cut);

      // 调用摘要函数，传入旧摘要实现增量压缩，旧摘要和新摘要结合生成新的摘要
      const newSummary = await buildSummary(toCompress, state.summary ?? "");

      // 返回状态更新指令：
      // 1. messages: 包含删除操作和新插入的摘要消息
      // 2. summary: 更新中间件状态中的摘要内容
      return {
        messages: [
          //
          // RemoveMessage 是 LangGraph 的特殊消息类型
          // 用于告知检查点（checkpointer）删除指定 ID 的历史消息
          // 这样可以释放存储空间并减少下次加载的消息量
          ...toCompress.map((m) => new RemoveMessage({ id: m.id! })),

          // 将生成的摘要包装为 SystemMessage 插入
          // 模型在后续调用中会看到这个摘要，从而了解之前的对话 context
          new SystemMessage(`【客服上下文摘要】\n${newSummary}`),
        ],
        summary: newSummary,
      };
    },
  });

  // ========== 创建 Agent ==========

  /**
   * 创建带历史压缩能力的 Agent
   *
   * 关键配置说明：
   * - model: 使用的 LLM 模型
   * - tools: 工具列表（本示例为空，纯对话场景）
   * - systemPrompt: 系统提示词，指导模型优先参考摘要信息
   * - middleware: 挂载的中间件数组（支持多个中间件组成管道）
   * - checkpointer: 状态持久化器，MemorySaver 将状态保存在内存中
   */
  const agent = createAgent({
    model: deepseekModel,
    tools: [],
    systemPrompt: "你是一名耐心的客服。优先调用历史摘要里的信息。",
    middleware: [summaryMw], // 注册压缩中间件
    checkpointer: new MemorySaver(), // 启用记忆功能，支持多轮对话
  });

  // thread_id 用于标识不同的对话会话
  // 同一 thread_id 的消息会共享同一个状态（包括摘要）
  const config = { configurable: { thread_id: "customer-A-001" } };

  // ========== 模拟多轮对话测试 ==========

  // 模拟 15 轮用户输入（加上 AI 回复共 30 条消息）
  // 当消息总数达到 TRIGGER(16) 时，middleware 会自动触发压缩
  const turns = [
    "你好，我是用户 A，订单号 12345，发货一周还没收到",
    "上面写的物流单号是 SF1234567890",
    "我之前催过两次都没人理",
    "我有点生气了，要求赔偿",
    "我希望明天就能拿到货",
    "我可以接受发顺丰特快",
    "另外，我下周要出差，得在周三之前收到",
    "我家地址是北京朝阳望京 SOHO 1 号楼",
    "电话是 138 0000 0000",
    "你能帮我升级处理吗？",
    "好的，那你回复我一下进度",
    "我先去吃午饭",
    "下午我会盯着这个工单",
    "如果有问题随时联系我",
    "现在能告诉我一下我的诉求总结吗？", // 这条消息后应该已经触发过压缩
    "我之前提到的物流单号是多少？", // 测试模型是否能从摘要中找到答案
  ];

  // 逐条发送用户消息，模拟真实对话流程
  for (const t of turns) {
    const r = await agent.invoke(
      { messages: [{ role: "user", content: t }] },
      config,
    );
    console.log(`\n用户: ${t}`);
    console.log(`客服: ${r.messages.at(-1)?.text}`);
    console.log(`消息: ${JSON.stringify(r.messages)}`);
  }

  // ========== 验证最终状态 ==========

  // 获取最终的 agent 状态，验证压缩效果
  const finalState = await agent.getState(config);
  console.log("\n=== 最终 state ===");

  // 预期：消息数量应该远小于原始消息数（因为旧消息已被 RemoveMessage 删除）
  console.log("消息条数:", finalState.values.messages.length);

  // 输出最终摘要内容，验证信息是否被正确保留
  console.log("摘要:\n", finalState.values.summary);
};

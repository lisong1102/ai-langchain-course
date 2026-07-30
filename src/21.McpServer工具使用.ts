/**
 * ============================================================================
 * MCP Server 工具使用示例
 * ============================================================================
 *
 * 本文件演示如何通过 MCP (Model Context Protocol) 协议使用外部工具。
 *
 * 【核心概念】
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                                                                     │
 * │  MCP (Model Context Protocol) = AI 模型的"插件标准"                 │
 * │                                                                     │
 * │  它定义了 AI 模型如何与外部工具/服务进行标准化交互。                  │
 * │  类似于 USB 接口：只要符合 MCP 标准，任何工具都能被 AI 模型调用。    │
 * │                                                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 【架构概览】
 *
 *   你的 Node.js 应用              MCP Server (子进程)
 *   ┌─────────────────┐          ┌─────────────────────────┐
 *   │                 │          │                         │
 *   │ MultiServerMCP  │  stdio   │ @modelcontextprotocol/  │
 *   │ Client (客户端) │ ←── RPC →│ server-filesystem      │
 *   │                 │  管道通信 │ (服务端)                │
 *   │                 │          │                         │
 *   │ 角色: 翻译官    │          │ 角色: 工具提供者         │
 *   │ • 建立连接      │          │ • 提供工具能力           │
 *   │ • 格式转换      │          │ • 执行具体操作           │
 *   └─────────────────┘          └─────────────────────────┘
 *            ↓                            ↑
 *            │     LangChain Tool 对象     │
 *            └────────────────────────────┘
 *                        ↓
 *                   Agent 使用
 *
 * 【通信机制详解】
 *
 * 1️⃣ 进程间通信 (IPC - Inter-Process Communication)
 *    ┌─────────────────────────────────────────────────────────────┐
 *    │                                                             │
 *    │  主进程 (你的应用)              子进程 (MCP Server)          │
 *    │  ┌─────────────────┐          ┌─────────────────┐          │
 *    │  │                 │ stdout   │                 │          │
 *    │  │    stdin ───────┼─────────→│ stdin           │          │
 *    │  │    (发送请求)   │  管道A   │ (接收请求)      │          │
 *    │  │                 │          │                 │          │
 *    │  │    stdout ←─────┼──────────│ stdout          │          │
 *    │  │    (接收响应)   │  管道B   │ (发送响应)      │          │
 *    │  │                 │          │                 │          │
 *    │  └─────────────────┘          └─────────────────┘          │
 *    │                                                             │
 *    │  数据格式: JSON-RPC 2.0 (每条消息以 \n 换行符结尾)            │
 *    │                                                             │
 *    └─────────────────────────────────────────────────────────────┘
 *
 * 2️⃣ JSON-RPC 协议示例
 *    请求: {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
 *    响应: {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
 *
 * 3️⃣ 传输方式对比
 *    ┌────────────┬─────────────────────┬────────────────────────┐
 *    │ stdio ✅   │ 本地进程间通信       │ 通过 stdin/stdout 管道  │
 *    ├────────────┼─────────────────────┼────────────────────────┤
 *    │ http       │ 远程 HTTP 服务      │ 通过 HTTP 请求          │
 *    ├────────────┼─────────────────────┼────────────────────────┤
 *    │ sse        │ 远程长连接服务      │ Server-Sent Events     │
 *    └────────────┴─────────────────────┴────────────────────────┘
 *
 * 【执行流程】
 *
 *  Step 1: new MultiServerMCPClient()  → 定义要连接的 MCP Server
 *  Step 2: client.getTools()           → 启动子进程 + 获取工具列表
 *  Step 3: createAgent()               → 将工具绑定到 Agent
 *  Step 4: agent.invoke()             → Agent 决定调用哪个工具
 *  Step 5: JSON-RPC 调用              → 通过管道让子进程执行操作
 *  Step 6: client.close()             → 关闭子进程，释放资源
 *
 * ============================================================================
 */

// 导入 MCP 客户端（用于建立和管理 MCP Server 连接）
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
// 导入 Anthropic 模型（本例未使用，但可用于替代 DeepSeek）
import { ChatAnthropic } from "@langchain/anthropic";
// 导入 LangChain 的 Agent 创建函数
import { createAgent } from "langchain";
// 导入自定义的 DeepSeek 模型配置
import { deepseekModel } from "./model/index.js";

export default async () => {
  // ==========================================================================
  // 第一步：创建 MCP 客户端，配置要连接的服务器
  // ==========================================================================
  //
  // 【重要】这里只是"声明"要连接哪些服务器，还没有真正启动！
  //         实际的子进程启动发生在 getTools() 调用时。
  //
  const client = new MultiServerMCPClient({
    mcpServers: {
      // 👇 服务器名称（自定义，用于标识这个连接）
      filesystem: {
        // 👇 传输方式：stdio（标准输入输出）
        //
        // 【含义】使用操作系统管道（Pipe）进行本地进程间通信
        //
        // 【底层原理】
        //   Node.js 会调用 child_process.spawn() 创建一个子进程，
        //   并在主进程和子进程之间建立两个管道：
        //   - Pipe A: 主进程 stdout → 子进程 stdin （发送 JSON-RPC 请求）
        //   - Pipe B: 子进程 stdout → 主进程 stdin （接收 JSON-RPC 响应）
        //
        // 【为什么用 stdio？】
        //   ✅ 只能用于本地（同一台机器）
        //   ✅ 安全性好（进程间天然隔离）
        //   ✅ 语言无关（只要支持 stdin/stdout 就能通信）
        //   ✅ 适合运行独立的工具服务
        //
        transport: "stdio",

        // 👇 要执行的命令
        //
        // 【说明】npx 是 Node.js 的包执行器
        //   -y 参数：自动下载并执行，不需要确认提示
        //   如果本地没有安装这个包，npx 会从 npm 临时下载到缓存目录
        //   缓存位置通常是：~/.npm/_npx/
        //
        command: "npx",

        // 👇 命令参数
        args: [
          "-y",  // 自动确认（yes to all prompts）

          // 👇 MCP Server 包名
          //
          // 【这是什么？】
          // 这是一个实现了 MCP 协议的文件系统服务器。
          // 它提供了以下工具能力：
          //   - read_file:      读取文件内容
          //   - write_file:     写入文件内容
          //   - create_directory: 创建目录
          //   - list_directory:   列出目录内容
          //   - move_file:       移动/重命名文件
          //   - search_files:    搜索文件内容
          //   - get_file_info:   获取文件元信息
          //   - list_allowed_directories: 列出允许访问的目录
          //
          // 【注意】这个包不会安装到你项目的 node_modules 中！
          //         它被缓存在 npx 的缓存目录里，按需加载。
          //
          "@modelcontextprotocol/server-filesystem",

          // 👇 服务器的工作目录（必须已存在！）
          //
          // 【作用】限制文件系统操作的根目录
          //   所有文件读写操作都被限制在这个目录内，保证安全性。
          //
          // 【常见错误】如果目录不存在会报错：
          //   "Cannot access directory /tmp/workspace, skipping"
          //   解决方法：mkdir -p /tmp/workspace
          //
          "/tmp/workspace",
        ],
      },
    },
  });

  // ==========================================================================
  // 第二步：获取 MCP Server 提供的工具
  // ==========================================================================
  //
  // 【这里发生了什么？】🚀 关键步骤！
  //
  // 1️⃣ 启动子进程
  //    内部调用: spawn("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"])
  //    这会在后台启动一个独立的 Node.js 进程来运行 MCP Server
  //
  // 2️⃣ 建立 JSON-RPC 通信
  //    主进程和子进程通过 stdin/stdout 管道建立双向通信通道
  //
  // 3️⃣ 发送初始化请求
  //    主进程发送: {"jsonrpc":"2.0","id":0,"method":"initialize","params":{...}}
  //    子进程返回: 协议版本、服务器能力等信息
  //
  // 4️⃣ 请求工具列表
  //    主进程发送: {"jsonrpc":"2.0","id":1,"method":"tools/list"}
  //    子进程返回:
    //    {
    //      "tools": [
    //        { "name": "read_file", "description": "...", "inputSchema": {...} },
    //        { "name": "write_file", "description": "...", "inputSchema": {...} },
    //        // ... 更多工具
    //      ]
    //    }
  //
  // 5️⃣ 格式转换
  //    MultiServerMCPClient 把 MCP 工具格式转换为 LangChain Tool 对象
  //    这样就能被 LangChain Agent 直接使用了
  //
  // 【返回值】tools 是一个 LangChain Tool 对象数组
  //   每个 Tool 包含：
  //   - name: 工具名称（如 "filesystem_read_file"）
  //   - description: 工具描述（告诉 AI 这个工具是做什么的）
  //   - schema: 参数定义（Zod schema，用于参数验证）
  //   - execute: 执行函数（内部通过 JSON-RPC 调用 MCP Server）
  //
  const tools = await client.getTools();

  // ==========================================================================
  // 第三步：创建 Agent，绑定工具
  // ==========================================================================
  //
  // 【Agent 是什么？】
  //   Agent = LLM 模型 + 工具 + 决策循环
  //
  //   它的工作流程：
  //   1. 接收用户消息
  //   2. 把消息 + 工具描述发给 LLM
  //   3. LLM 决定是否需要调用工具
  //   4. 如果需要 → 调用工具 → 把结果再发给 LLM
  //   5. 重复步骤 3-4 直到 LLM 认为可以回答了
  //   6. 返回最终答案
  //
  // 【工具是如何被调用的？】
  //   当 LLM 决定调用工具时（比如 write_file）：
  //
  //   Agent → Tool.execute() → MultiServerMCPClient
  //                                ↓
  //                          发送 JSON-RPC 请求
  //                          {"jsonrpc":"2.0","id":2,
  //                           "method":"tools/call",
  //                           "params":{
  //                             "name":"write_file",
  //                             "arguments":{"path":"...","content":"..."}
  //                           }}
  //                                ↓
  //                          通过 stdout 管道发送给子进程
  //                                ↓
  //                          子进程接收并执行实际的文件写入
  //                                ↓
  //                          子进程返回结果通过 stdout 管道传回
  //                                ↓
  //                          结果返回给 Agent → 返回给 LLM 继续推理
  //
  const agent = createAgent({
    model: deepseekModel,  // 👈 使用的 LLM 模型

    // 👈 从 MCP Server 获取的工具数组
    tools,

    // 👈 系统提示词（指导 AI 如何使用这些工具）
    systemPrompt:
      "你是一个文件系统助手。所有操作都在 /tmp/workspace 内进行。完成后简短回报结果。",
  });

  // ==========================================================================
  // 第四步：调用 Agent 执行任务
  // ==========================================================================
  //
  // 【完整的执行流程】
  //
  // 用户问题: "请在 /tmp/workspace 下创建一个 hello.txt"
  //
  // 循环 1:
  //   LLM 思考: 用户要我创建文件，我需要调用 write_file 工具
  //   Agent: 调用 filesystem_write_file(path="/tmp/workspace/hello.txt", content="Hello, MCP!")
  //   → JSON-RPC → 子进程执行写入 → 返回成功
  //
  // 循环 2:
  //   LLM 收到: 文件创建成功
  //   LLM 思考: 用户还要求读取确认，我需要调用 read_file 工具
  //   Agent: 调用 filesystem_read_file(path="/tmp/workspace/hello.txt")
  //   → JSON-RPC → 子进程执行读取 → 返回文件内容
  //
  // 循环 3:
  //   LLM 收到: 文件内容是 "Hello, MCP!"
  //   LLM 思考: 任务完成，我可以回复用户了
  //   Agent: 返回最终答案
  //
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "请在 /tmp/workspace 下创建一个 hello.txt，内容是 'Hello, MCP!'，然后读取它确认内容",
      },
    ],
  });

  // 打印 Agent 的最终回复
  console.log(result.messages.at(-1)?.content);

  // ==========================================================================
  // 第五步：关闭连接，清理资源
  // ==========================================================================
  //
  // 【为什么要手动关闭？】
  //
  // 1️⃣ MCP Server 是一个独立的后台进程，如果不关闭会一直运行
  //    浪费系统资源（内存、CPU、文件句柄等）
  //
  // 2️⃣ close() 会：
  //    - 向子进程的 stdin 发送关闭信号
  //    - 等待子进程优雅退出（最多等 2 秒）
  //    - 如果超时未退出，发送 SIGTERM 信号
  //    - 如果还是没退出，强制发送 SIGKILL 终止
  //    - 清理所有缓冲区和连接状态
  //
  // 【最佳实践】
  //   务必在 finally 块或程序结束时调用 close()，
  //   避免僵尸进程占用资源！
  //
  await client.close();
};

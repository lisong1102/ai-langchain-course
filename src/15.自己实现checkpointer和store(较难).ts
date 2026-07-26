// ============================================================================
// 🎯 RedisCheckpointer — 自己实现的、基于 Redis 的状态持久化组件
//
// 【核心定位】
//   替代 LangChain 内置的 MemorySaver（数据存在进程内存 Map 里），
//   把 Agent 的对话状态存到 Redis 服务器中。
//
// 【为什么需要这个？】
//   MemorySaver 的数据存在内存里，进程重启就没了。
//   Redis 版本支持：跨进程重启保留数据、多服务器共享同一份记忆。
//
// 【谁在调用这个类？】
//   不是你手动调用！是 LangGraph 框架在每次 agent.invoke() 时自动调用：
//     1. invoke 开始 → 框架调 getTuple() → 从 Redis 读历史消息
//     2. invoke 结束 → 框架调 put()      → 把新状态写入 Redis
//
// 【你需要做的只有两件事】
//   1. 创建实例：new RedisCheckpointer({ url: "redis://..." })
//   2. 传给 Agent：checkpointer: new RedisCheckpointer(...)
//   剩下的读写操作，框架会全自动完成
// ============================================================================

import {
  BaseCheckpointSaver,       // 👈 父类，LangGraph 定义的检查点基类（必须继承它）
  type Checkpoint,           // 检查点数据结构（包含 id、values/messages 等）
  type CheckpointMetadata,   // 元数据（时间戳、source、step）
  type CheckpointTuple,      // getTuple 的返回类型（config + checkpoint + metadata + pendingWrites）
  type PendingWrite,         // 待写入的中间数据（Agent 循环调用工具时产生的"半成品"）
  type SerializerProtocol,   // 序列化器接口（负责 JS 对象 ↔ 二进制字节 的转换）
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";  // LangChain 的配置类型
import Redis from "ioredis"; // Redis 客户端库

export class RedisCheckpointer extends BaseCheckpointSaver {
  private client: Redis;        // Redis 连接实例
  private prefix: string;       // Redis key 的前缀（避免和业务其他数据冲突）
  private ttlSeconds?: number;  // 数据过期时间（秒），可选

  constructor(opts: {
    url?: string;               // Redis 地址，默认 localhost:6379
    prefix?: string;            // key 前缀，默认 "lg:cp:"（LangGraph CheckPoint）
    ttlSeconds?: number;        // 过期时间，设置后数据会自动清理（适合有合规要求的场景）
    serde?: SerializerProtocol; // 自定义序列化方式（一般用默认的 JSON 就行）
  }) {
    super(opts.serde);          // 调用父类构造函数，传入序列化器
    this.client = new Redis(opts.url ?? "redis://localhost:6379");
    this.prefix = opts.prefix ?? "lg:cp:";
    this.ttlSeconds = opts.ttlSeconds;
  }

  // ============================================================================
  // 🔑 Redis Key 设计（核心架构）
  //
  // 每个 thread_id（会话）在 Redis 中会有 4 种 key，各司其职：
  //
  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ Key 类型  │ 用途                    │ Redis 数据结构 │ 对应方法     │
  // ├───────────┼─────────────────────────┼───────────────┼──────────────┤
  // │ cp:{cid}  │ 存 checkpoint 完整数据   │ String        │ get/put      │
  // │ latest    │ 指向最新的 checkpoint ID │ String        │ get(快速定位)│
  // │ list      │ 按时间排序的所有历史 ID   │ Sorted Set    │ list(遍历)   │
  // │ writes:{} │ 该 checkpoint 的中间写⼊  │ Hash          │ putWrites    │
  // └─────────────────────────────────────────────────────────────────────┘
  //
  // 具体示例（thread_id="user-A", checkpoint_ns=""）：
  //   lg:cp:thread:user-A::cp:abc-123     → { messages: [...], ... }  (完整数据)
  //   lg:cp:thread:user-A::latest         → "abc-123"                (最新指针)
  //   lg:cp:thread:user-A::list           → { 1700..: "abc-123" }    (时间线)
  //   lg:cp:thread:user-A::writes:abc-123 → { "task0:0": data }     (待写数据)
  // ============================================================================

  /** 生成存储 checkpoint 本体的 key */
  private keyCp(tid: string, ns: string, cid: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:cp:${cid}`;
  }

  /** 生成存储"最新 checkpoint ID 指针"的 key */
  private keyLatest(tid: string, ns: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:latest`;
  }

  /** 生成存储"有序历史列表"的 key（Sorted Set，按时间排序） */
  private keyList(tid: string, ns: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:list`;
  }

  /** 生成存储 pending writes 的 key（Hash 结构） */
  private keyWrites(tid: string, ns: string, cid: string) {
    return `${this.prefix}thread:${tid}:ns:${ns}:writes:${cid}`;
  }

  // ============================================================================
  // 📖 getTuple() — 从 Redis 读取一个 checkpoint（最常用的读操作）
  //
  // 【什么时候被调用？】
  //   每次 agent.invoke() 时，LangGraph 框架自动调用此方法。
  //   目的：取出该会话的历史对话消息，和新消息合并后发给 LLM。
  //
  // 【调用者是谁？】
  //   LangGraph 框架（不是你！你只需要传 thread_id，框架负责调用）
  //
  // 【执行流程】
  //   1. 从 config 中取 thread_id（你传的）
  //   2. 如果指定了 checkpoint_id → 直接去取那个版本
  //   3. 如果没指定 → 先查 "latest" key 拿到最新版本的 ID
  //   4. 用 ID 去取完整的 checkpoint 数据（包含所有历史 messages）
  //   5. 再去取该 checkpoint 的 pending writes（如果有）
  //   6. 反序列化后返回给框架
  //
  // 【类比】
  //   就像理发店前台拿到你的会员卡号(thread_id)，
  //   去档案柜查出你的完整剪发记录(checkpoint)，交给理发师参考。
  // ============================================================================
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    // 从配置中提取三个关键参数（都是框架帮你填好的）
    const tid = config.configurable?.thread_id as string;            // 会话ID，比如 "user-lisong"
    const ns = (config.configurable?.checkpoint_ns ?? "") as string; // 命名空间，一般默认为空
    let cid = config.configurable?.checkpoint_id as string | undefined; // 要取哪个具体的 checkpoint

    // 🔑 如果没指定 checkpoint_id，就去拿"最新"的那个
    if (!cid) {
      // 读 latest key → 得到最新 checkpoint 的 ID（类似 "abc-123"）
      cid = (await this.client.get(this.keyLatest(tid, ns))) ?? undefined;
      if (!cid) return undefined;  // 第一次使用，Redis 里还没有任何数据
    }

    // 🔑 用 checkpoint ID 去取完整的 checkpoint 数据（二进制格式）
    const raw = await this.client.getBuffer(this.keyCp(tid, ns, cid));
    if (!raw) return undefined;  // 数据不存在（异常情况）

    // 🔑 反序列化：二进制字节 → JS 对象
    //    serde 是父类提供的序列化器，默认用 JSON 格式
    //    返回的 checkpoint.values.messages 就是完整的对话历史！
    const { checkpoint, metadata } = await this.serde.loadsTyped("json", raw);

    // 🔑 取出 pending writes（该 checkpoint 产生的但还没最终提交的中间数据）
    //    在 Agent 多步循环（比如连续调用多个工具）的场景下会产生
    const writesHash = await this.client.hgetallBuffer(
      this.keyWrites(tid, ns, cid),
    );
    const pendingWrites: [string, string, unknown][] = [];
    for (const [field, value] of Object.entries(writesHash)) {
      // field 格式是 "taskId:索引"，例如 "tool-call-001:0"
      const [taskId, idx] = field.split(":");
      const [channel, val] = await this.serde.loadsTyped(
        "json",
        value as Buffer,
      );
      pendingWrites.push([taskId, channel, val]);
    }

    // 🔑 返回完整的元组给 LangGraph 框架
    return {
      config: {
        configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: cid },
      },
      checkpoint,      // 核心数据：里面包含 values.messages（所有历史对话！）
      metadata,        // 辅助信息：时间戳等
      pendingWrites,   // 中间数据：未完成的写入操作
    };
  }

  // ============================================================================
  // 📋 list() — 列出某个会话的所有历史 checkpoint
  //
  // 【什么时候被调用？】
  //   一般在调试时使用——查看某个会话的状态演变历史（时间旅行功能）。
  //   正常的 agent.invoke() 流程不会调用这个方法。
  //
  // 【特点】
  //   使用 AsyncGenerator（生成器），懒加载模式，
  //   不会一次性把所有数据读到内存，而是按需逐个返回。
  //
  // 【底层原理】
  //   利用 Redis Sorted Set 的 ZREVRANGE 命令，
  //   按 score（时间戳）倒序返回，即从新到旧排列。
  // ============================================================================
  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig },
  ): AsyncGenerator<CheckpointTuple> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const limit = options?.limit ?? -1;  // -1 表示不限制，返回全部

    // 🔑 zrevrange = 按 score 倒序取（从最新到最旧）
    //    Sorted Set 的 member 是 checkpoint_id，score 是存入时的时间戳
    //    例如返回: ["cp-100", "cp-99", "cp-98", ...]
    const ids = await this.client.zrevrange(
      this.keyList(tid, ns),
      0,
      limit - 1,  // Redis range 是闭区间，所以用 limit-1
    );

    // 🔑 逐个调用 getTuple() 取出完整数据，yield 返回（懒加载）
    for (const cid of ids) {
      const tuple = await this.getTuple({
        configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: cid },
      });
      if (tuple) yield tuple;
    }
  }

  // ============================================================================
  // 💾 put() — 把一个新的 checkpoint 写入 Redis（核心写操作）
  //
  // 【什么时候被调用？】
  //   每次 agent.invoke() 执行完毕后，LangGraph 框架自动调用此方法。
  //   目的：把本次对话产生的新状态（包含所有历史 + 本次新消息）持久化保存。
  //
  // 【checkpoint 参数是谁创建的？】
  //   是 LangGraph 框架内部创建的！不是你创建的。
  //   框架会把：历史 messages + 新消息 + 模型回复 → 打包成 Checkpoint 对象 → 传给你
  //   你只负责把它存到 Redis。
  //
  // 【一次 put 会同时写入 3 个 Redis key】（用 Pipeline 保证原子性）：
  //   ① cp:{id}  → 存完整的 checkpoint 数据（本体）
  //   ② latest   → 更新"最新"指针（方便下次 O(1) 快速读取）
  //   ③ list     → 加入有序集合（维护时间线，支持 list() 遍历）
  // ============================================================================
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,           // 👈 框架传给你的完整状态对象（你不用创建）
    metadata: CheckpointMetadata,     // 👈 框架传给你的元数据（时间戳等）
    newVersions: Record<string, string | number>,  // 版本号（用于并发控制）
  ): Promise<RunnableConfig> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const cid = checkpoint.id;  // checkpoint 自带唯一 ID（框架生成的，类似 uuid）

    // 🔑 序列化：JS 对象 → 二进制字节（才能存进 Redis）
    //    dumpsTyped 返回 [format, payload]，我们只需要 payload 部分
    const [, payload] = await this.serde.dumpsTyped({ checkpoint, metadata });

    // 🔑 使用 Redis Pipeline 一次性发送多条命令
    //    Pipeline 的好处：减少网络往返次数（3条命令只需1次网络通信）
    const pipeline = this.client.pipeline();

    // ① 存 checkpoint 本体（String 类型，key = cp:{id}，value = 二进制数据）
    pipeline.set(this.keyCp(tid, ns, cid), payload);

    // ② 更新"最新"指针（String 类型，始终指向最新的 checkpoint ID）
    //    下次 getTuple() 时直接读这个 key，O(1) 时间复杂度
    pipeline.set(this.keyLatest(tid, ns), cid);

    // ③ 加入有序列表（Sorted Set，score = 当前时间戳，member = checkpoint ID）
    //    这样 list() 方法可以按时间倒序遍历所有历史版本
    pipeline.zadd(this.keyList(tid, ns), Date.now(), cid);

    // 可选：设置 TTL（过期时间），用于自动清理长期不活跃的会话
    if (this.ttlSeconds) {
      pipeline.expire(this.keyCp(tid, ns, cid), this.ttlSeconds);
      pipeline.expire(this.keyLatest(tid, ns), this.ttlSeconds);
      pipeline.expire(this.keyList(tid, ns), this.ttlSeconds);
    }

    // 🔑 一次性执行 Pipeline 中缓存的所有命令
    await pipeline.exec();

    // 🔑 返回更新后的 config（包含新的 checkpoint_id），框架会用它做后续处理
    return {
      configurable: { thread_id: tid, checkpoint_ns: ns, checkpoint_id: cid },
    };
  }

  // ============================================================================
  // 📝 putWrites() — 存储 pending writes（中间写入数据）
  //
  // 【什么是 pending writes？】
  //   在 LangGraph 的 Agent 循环中，一次 invoke 可能包含多步操作：
  //     用户问题 → 模型决定调工具A → 工具A返回结果 → 模型再调工具B → ...
  //   每一步产生的"半成品"数据就是 pending write，
  //   它们属于当前 checkpoint 但还未被正式合并到主状态中。
  //
  // 【什么时候被调用？】
  //   Agent 循环执行过程中，每完成一步工具调用后，框架可能调用此方法。
  //
  // 【存储结构】
  //   使用 Redis Hash，field 格式为 "taskId:索引"，
  //   同一任务的多次写入不会互相覆盖。
  // ============================================================================
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],  // 待写入的数据数组，形如 [["messages", msg1], ["messages", msg2]]
    taskId: string,          // 任务标识（标识这是哪次 invoke 循环中的写入）
  ): Promise<void> {
    const tid = config.configurable?.thread_id as string;
    const ns = (config.configurable?.checkpoint_ns ?? "") as string;
    const cid = config.configurable?.checkpoint_id as string;

    const pipeline = this.client.pipeline();

    // 🔑 逐条序列化并写入 Hash
    //    注意：dumpsTyped 是异步的，必须用 for...of + await（不能用 forEach）
    let idx = 0;
    for (const [channel, value] of writes) {
      const [, payload] = await this.serde.dumpsTyped([channel, value]);
      // Hash 的 field 用 "taskId:索引" 格式，避免同任务多次写入冲突
      pipeline.hset(this.keyWrites(tid, ns, cid), `${taskId}:${idx}`, payload);
      idx += 1;
    }

    // 可选：设置 TTL
    if (this.ttlSeconds) {
      pipeline.expire(this.keyWrites(tid, ns, cid), this.ttlSeconds);
    }

    await pipeline.exec();
  }

  // ============================================================================
  // 🗑️ deleteThread() — 删除某个会话的全部数据
  //
  // 【使用场景】
  //   - GDPR/隐私合规：用户要求删除其所有数据
  //   - 清理过期/废弃的会话，释放 Redis 内存
  //   - 用户注销账号时清除相关数据
  //
  // 【为什么要用 SCAN 而不是 KEYS？】
  //   KEYS * 命令会遍历整个 Redis 数据库，在大数据量时会阻塞 Redis 单线程，
  //   导致所有请求卡住。SCAN 是增量式迭代，不会阻塞，是生产环境的推荐做法。
  // ============================================================================
  async deleteThread(threadId: string): Promise<void> {
    // 构造匹配模式：匹配该 threadId 下的所有 key
    // 例如: "lg:cp:thread:user-123:*"
    const pattern = `${this.prefix}thread:${threadId}:*`;

    // 🔑 使用 scanStream 增量扫描（每次返回一批 key，不会阻塞 Redis）
    const stream = this.client.scanStream({ match: pattern, count: 100 });
    for await (const keys of stream) {
      if ((keys as string[]).length > 0) {
        // 批量删除匹配到的 key
        await this.client.del(...(keys as string[]));
      }
    }
  }
}

# 1.安装

```js
npm install @langchain/core @langchain/openai @langchain/anthropic langchain
```

| 包名                   | 职责                                                        | 何时用到       |
| ---------------------- | ----------------------------------------------------------- | -------------- |
| `@langchain/core`      | 核心抽象：Runnable、Message、Prompt Template、Output Parser | 每个模块都会用 |
| `@langchain/openai`    | OpenAI 模型集成（GPT-5、GPT-4o、Embedding）                 | 模块 1 开始    |
| `@langchain/anthropic` | Anthropic Claude 4.x 集成                                   | 模块 1 开始    |
| `langchain`            | Agent 主入口：`createAgent`、Middleware、Retriever          | 模块 5 开始    |

# 2.Runnable简化版

- Runnable是一个接口， 是所有核心组件的统一抽象
- prompt` / `model` / `parser` / `chain都是Runnable的实现
- 通过pipe会生成一个新的链对象chain
- pipe()返回一个"包装了当前组件和下一个组件的新链对象"。这样每次 `.pipe()` 都是在扩展这个链，而不是替换它

```tsx
class Runnable<Input, Output> {
  constructor(private name: string) {}
  
  // pipe 返回新的链对象，而不是 this 或 next
  pipe<NewOutput>(next: Runnable<Output, NewOutput>) {
    return new RunnableSequence(this, next);
  }
  
  async invoke(input: Input): Promise<Output> {
    console.log(`[${name}] 处理中...`);
    return input as any; // 简化
  }
}

// 链对象：持有所有步骤
class RunnableSequence<Input, Output> extends Runnable<Input, Output> {
  constructor(
    private steps: Runnable<any, any>[]
  ) { super("sequence"); }
  
  async invoke(input: Input): Promise<Output> {
    let currentInput = input;
    
    // 依次执行每个步骤
    for (const step of this.steps) {
      currentInput = await step.invoke(currentInput);
    }
    
    return currentInput;
  }
  
  // 继续支持 pipe
  pipe<NewOutput>(next: Runnable<Output, NewOutput>) {
    // 把 next 添加到步骤列表末尾，返回新链
    return new RunnableSequence([...this.steps, next]);
  }
}
```


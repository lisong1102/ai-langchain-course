// 嵌套路由：能用但要克制
// RunnableBranch 可以嵌套，写多级决策树：

// const nested = RunnableBranch.from([
//   [
//     (input) => input.category === "tech",
//     RunnableBranch.from([
//       [(input) => input.subcategory === "frontend", frontendChain],
//       [(input) => input.subcategory === "backend", backendChain],
//       generalTechChain,
//     ]),
//   ],
//   [(input) => input.category === "business", businessChain],
//   defaultChain,
// ]);

// 超多两层嵌套就不用RunnableBranch了，改用Map
// import { RunnableLambda, type Runnable } from "@langchain/core/runnables";

// const chainRegistry = new Map<string, Runnable>([
//   ["tech.frontend", frontendChain],
//   ["tech.backend", backendChain],
//   ["tech.default", generalTechChain],
//   ["business", businessChain],
// ]);

// const lookupRouter = new RunnableLambda({
//   func: async (input: { category: string; subcategory?: string }) => {
//     const key = input.subcategory
//       ? `${input.category}.${input.subcategory}`
//       : input.category;
//     const chain =
//       chainRegistry.get(key) ??
//       chainRegistry.get(`${input.category}.default`) ??
//       defaultChain;
//     return chain.invoke(input);
//   },
// });

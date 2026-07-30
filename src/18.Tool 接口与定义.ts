// weather-tool.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
export default async () => {
  const getWeather = tool(
    async ({ city, unit }) => {
      // 这里真实项目应该调天气 API，演示用假数据
      const data: Record<string, { temp: number; condition: string }> = {
        北京: { temp: 18, condition: "晴" },
        上海: { temp: 22, condition: "多云" },
      };
      const found = data[city];
      if (!found) {
        return JSON.stringify({ error: `未找到城市 "${city}"` });
      }
      const temp =
        unit === "fahrenheit" ? (found.temp * 9) / 5 + 32 : found.temp;
      return JSON.stringify({
        city,
        temperature: temp,
        unit,
        condition: found.condition,
      });
    },
    {
      name: "get_weather",
      description:
        "查询某个城市的实时天气，包含温度和天气状况。支持的城市：北京、上海。",
      schema: z.object({
        city: z.string().describe("城市名，如 '北京'"),
        unit: z
          .enum(["celsius", "fahrenheit"])
          .default("celsius")
          .describe("温度单位"),
      }),
    },
  );

  // 直接调用测试
  console.log("aa");
  const result = await getWeather.invoke({ city: "北京", unit: "celsius" });
  console.log(result);
  console.log("bb");
  // 输出: {"city":"北京","temperature":18,"unit":"celsius","condition":"晴"}
};

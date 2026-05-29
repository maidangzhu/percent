import { Mastra } from "@mastra/core/mastra";
import { percentAgent } from "./agents/percentAgent.js";

export const mastra = new Mastra({
  agents: {
    percentAgent,
  },
});

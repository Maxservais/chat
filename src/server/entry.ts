import { routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";

// Export the Durable Object class — Cloudflare requires this from the main module
export { ChatAgent } from "./agent";

export default {
  async fetch(request: Request) {
    // Handle agent WebSocket/API requests (/agents/*)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Delegate everything else to TanStack Start
    return handler.fetch(request);
  },
};

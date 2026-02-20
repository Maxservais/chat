import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import { scrapeTweets } from "./twitter-scraper";
import type { ChatAgent } from "./agent";

export interface TwitterWorkflowParams {
  handle: string;
}

export interface TwitterInterestProfile {
  handle: string;
  interests: string[];
  summary: string;
  tweetCount: number;
}

export interface TwitterWorkflowError {
  handle: string;
  error: string;
}

export type TwitterWorkflowResult = TwitterInterestProfile | TwitterWorkflowError;

type ProgressType = {
  step: string;
  status: "running" | "complete" | "error";
  message: string;
  percent?: number;
};

export class TwitterAnalysisWorkflow extends AgentWorkflow<
  ChatAgent,
  TwitterWorkflowParams,
  ProgressType
> {
  async run(
    event: AgentWorkflowEvent<TwitterWorkflowParams>,
    step: AgentWorkflowStep
  ) {
    const { handle } = event.payload;

    // Step 1: Scrape tweets via Apify (durable, retriable)
    const scrapeResult = await step.do(
      "scrape-tweets",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      },
      async () => {
        await this.reportProgress({
          step: "scrape",
          status: "running",
          message: `Fetching latest tweets from @${handle}...`,
          percent: 0.1,
        });

        const result = await scrapeTweets(
          handle,
          this.env.APIFY_API_TOKEN
        );

        await this.reportProgress({
          step: "scrape",
          status: "complete",
          message: `Fetched ${result.tweetCount} tweets from @${handle}`,
          percent: 0.4,
        });

        return result;
      }
    );

    // Abort early if no tweets found (don't send empty prompt to LLM)
    // Return error result instead of throwing — onWorkflowError doesn't fire
    // reliably for throws in run(), but onWorkflowComplete always fires.
    if (scrapeResult.tweetCount === 0) {
      const errorMsg = `No tweets found for @${handle}. The account may not exist, be private, or have no tweets.`;
      await this.reportProgress({
        step: "scrape",
        status: "error",
        message: errorMsg,
      });
      const errorResult: TwitterWorkflowError = { handle, error: errorMsg };
      await step.reportComplete(errorResult);
      return errorResult;
    }

    // Step 2: Summarize interests using a larger model (durable, retriable)
    const profile = await step.do(
      "summarize-interests",
      {
        retries: { limit: 2, delay: "3 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      },
      async () => {
        await this.reportProgress({
          step: "analyze",
          status: "running",
          message: "Analyzing interests from tweets...",
          percent: 0.5,
        });

        const workersai = createWorkersAI({ binding: this.env.AI });
        const filteredTweets = scrapeResult.tweets
          .map((t) => t.text)
          .filter((t) => t.length > 10); // skip very short/empty tweets

        console.log(`[twitter-workflow] Summarizing ${filteredTweets.length}/${scrapeResult.tweets.length} tweets (after filtering short ones)`);

        if (filteredTweets.length === 0) {
          throw new Error(
            `No usable tweet content found for @${handle}. The account may be private or only has very short tweets.`
          );
        }

        const tweetTexts = filteredTweets.join("\n---\n");
        console.log(`[twitter-workflow] Total prompt length: ${tweetTexts.length} chars`);
        console.log(`[twitter-workflow] First tweet sample: "${filteredTweets[0]?.slice(0, 150)}"`);

        const result = await generateText({
          // @ts-expect-error -- model not yet in workers-ai-provider type list
          model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
          system: `You are analyzing a Twitter/X user's tweets to understand their professional interests, especially related to blockchain, crypto, Ethereum, and technology.

Extract the user's top interests and topics they care about. Focus on topics that would be relevant to attending an Ethereum conference (EthCC).

Return ONLY a valid JSON object with this exact structure:
{
  "interests": ["topic1", "topic2", "topic3"],
  "summary": "2-3 sentence summary of their professional interests"
}

Rules:
- Maximum 10 interests
- Each interest should be 1-4 words (e.g. "DeFi protocols", "Zero-knowledge proofs", "MEV", "Account abstraction")
- The summary should be concise and professional
- If the tweets aren't related to crypto/tech, still extract whatever professional interests are visible
- Return ONLY the JSON, no markdown, no explanation`,
          prompt: `Tweets from @${handle}:\n\n${tweetTexts}`,
          maxOutputTokens: 512,
        });

        // Parse the LLM output
        console.log(`[twitter-workflow] LLM raw response (${result.text.length} chars): "${result.text.slice(0, 300)}"`);

        let parsed: { interests: string[]; summary: string };
        try {
          const jsonStr = result.text.replace(/```json?\n?|```/g, "").trim();
          parsed = JSON.parse(jsonStr);
          console.log(`[twitter-workflow] Parsed ${parsed.interests.length} interests`);
        } catch (e) {
          console.error(`[twitter-workflow] Failed to parse LLM JSON:`, e);
          console.error(`[twitter-workflow] Raw text was: "${result.text}"`);
          // Fallback: extract what we can
          parsed = {
            interests: ["Ethereum", "blockchain"],
            summary: `Based on @${handle}'s tweets, they appear interested in blockchain and crypto topics.`,
          };
        }

        const profile: TwitterInterestProfile = {
          handle,
          interests: parsed.interests.slice(0, 10),
          summary: parsed.summary,
          tweetCount: scrapeResult.tweetCount,
        };

        await this.reportProgress({
          step: "analyze",
          status: "complete",
          message: `Identified ${profile.interests.length} interests from ${profile.tweetCount} tweets`,
          percent: 0.9,
        });

        return profile;
      }
    );

    // Step 3: Store in agent state (durable)
    await step.mergeAgentState({
      twitterProfile: profile,
    });

    await this.reportProgress({
      step: "done",
      status: "complete",
      message: "Analysis complete!",
      percent: 1.0,
    });

    await step.reportComplete(profile);

    return profile;
  }
}

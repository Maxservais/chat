# Twitter Profile Analysis → Personalized EthCC Recommendations

## Architecture: Agent triggers Workflow

The ChatAgent detects when a user shares a Twitter/X handle, triggers a durable Workflow that scrapes and analyzes their tweets, then injects the resulting interest profile into the system prompt for personalized talk recommendations.

```
User: "My Twitter is @vitalik"
         │
    ┌────┴────────────────────┐
    │  ChatAgent (DO)         │
    │  Detects Twitter handle │
    │  → runWorkflow()        │
    │  → Responds: "Analyzing │
    │    your profile..."     │
    └────┬────────────────────┘
         │
    ┌────▼────────────────────────────────────────┐
    │  TwitterAnalysisWorkflow (AgentWorkflow)     │
    │                                              │
    │  step.do("scrape-tweets")                    │
    │    → Apify API (100 latest tweets)           │
    │    → reportProgress({ step: "scraping" })    │
    │                                              │
    │  step.do("summarize-interests")              │
    │    → llama-3.3-70b-instruct-fp8-fast         │
    │    → reportProgress({ step: "analyzing" })   │
    │                                              │
    │  step.mergeAgentState({ twitterProfile })    │
    │  step.reportComplete(profile)                │
    └────┬────────────────────────────────────────┘
         │
    ┌────▼────────────────────────┐
    │  onWorkflowComplete()       │
    │  → Broadcast to client (WS) │
    │  → Push message + persist   │
    │    (dedup by message ID)    │
    └────┬────────────────────────┘
         │
    ┌────▼──────────────────────────┐
    │  Frontend shows profile card  │
    │  (inline in chat history)     │
    │  User: "Yes, find me talks!"  │
    └────┬──────────────────────────┘
         │
    ┌────▼────────────────────┐
    │  ChatAgent              │
    │  System prompt now has   │
    │  interests → searchTalks │
    │  → Personalized recs    │
    └─────────────────────────┘
```

## Files

| File | Role |
|------|------|
| `src/server/twitter-scraper.ts` | Apify Tweet Scraper V2 (`apidojo~tweet-scraper`) integration. Calls the sync endpoint, returns structured tweet data. |
| `src/server/twitter-workflow.ts` | `TwitterAnalysisWorkflow` extending `AgentWorkflow`. Two durable steps with retries: scrape tweets → summarize interests via `llama-3.3-70b-instruct-fp8-fast`. Stores result in agent state. |
| `src/server/agent.ts` | `ChatAgent` updated with: workflow lifecycle callbacks (`onWorkflowProgress`, `onWorkflowComplete`, `onWorkflowError`), Twitter handle detection via regex, interests injection into system prompt. |
| `src/server/entry.ts` | Exports `TwitterAnalysisWorkflow` alongside `ChatAgent`. |
| `src/components/chat/AgentChat.tsx` | Handles workflow WebSocket events (`workflow-progress`, `workflow-complete`, `workflow-error`). Shows progress indicator, interest profile card with badges, and error state. |
| `wrangler.jsonc` | Workflow binding: `TWITTER_ANALYSIS_WORKFLOW` → `TwitterAnalysisWorkflow`. |
| `.dev.vars` | Contains `APIFY_API_TOKEN` for local development. |

## Key Design Decisions

### Why Workflow instead of a tool?
- **Durability**: Scraping can fail (rate limits, timeouts). Workflow steps are individually retriable with exponential backoff.
- **Progress reporting**: `reportProgress()` triggers `onWorkflowProgress()` on the agent, which broadcasts to the client via WebSocket. The frontend shows a real-time progress bar.
- **Model separation**: The workflow uses `llama-3.3-70b-instruct-fp8-fast` for tweet analysis (needs larger context), while the chat agent uses `glm-4.7-flash` for interactive responses.

### Why regex for Twitter handle detection?
- Simpler than making an LLM call to detect intent.
- Three regexes checked in priority order:
  1. `TWITTER_URL_RE` — `x.com/username` or `twitter.com/username` URLs
  2. `TWITTER_HANDLE_RE` — natural language ("my twitter is @username", "twitter: handle")
  3. `TWITTER_CORRECTION_RE` — corrections ("it's actually @handle", "try handle")
- The handle regexes require contextual keywords to avoid false positives from bare @mentions.

### Two-step UX with confirmation
After analyzing the profile, the frontend shows the interests as badges. The user confirms or refines before the agent searches for talks. This prevents wasted searches on inaccurate interest extraction.

### Error handling: return error results, don't throw
The SDK's `onWorkflowError` callback doesn't fire reliably for errors thrown in `run()` (outside `step.do`). Instead, the workflow returns a typed error result (`TwitterWorkflowError`) via `step.reportComplete()`. The agent's `onWorkflowComplete` checks `"error" in result` to distinguish success from failure, then pushes the appropriate chat message.

### Message persistence with dedup
`onWorkflowComplete` pushes messages via `this.messages.push()` + `this.persistMessages()`. Messages use deterministic IDs (`twitter-profile-${handle}`, `twitter-error-${handle}`) so the dedup guard `this.messages.some(m => m.id === msgId)` prevents duplicates if the callback fires more than once.

### Profile card rendering
The frontend matches messages by ID (`message.id === \`twitter-profile-${handle}\``) to render the profile card UI instead of a plain text bubble. This avoids false positives from text-content matching.

### State flow
1. Workflow stores profile in agent state via `step.mergeAgentState({ twitterProfile })`.
2. Agent reads `this.state?.twitterProfile` on every subsequent `onChatMessage`.
3. If present, the interest profile is appended to the system prompt as a `USER PROFILE` section.

## Apify Integration

- **Actor**: `apidojo/tweet-scraper` (Tweet Scraper V2)
- **Endpoint**: `POST https://api.apify.com/v2/acts/apidojo~tweet-scraper/run-sync-get-dataset-items?token=...`
- **Input**: `{ twitterHandles: ["handle"], maxItems: 50, sort: "Latest" }`
- **Output**: Array of tweet objects with `text`, `createdAt`, `likeCount`, `retweetCount`
- **Pricing**: ~$0.02 per profile analysis (50 tweets at $0.40/1000)
- **Sync timeout**: Up to 300s (5 minutes) — the sync endpoint waits for the actor to complete

## WebSocket Event Protocol

Events broadcast from agent to frontend:

```typescript
// Progress update (during workflow execution)
{ type: "workflow-progress", step: "scrape" | "analyze" | "done", status: "running" | "complete" | "error", message: string, percent: number }

// Workflow completed successfully — result is TwitterInterestProfile
{ type: "workflow-complete", result: { handle: string, interests: string[], summary: string, tweetCount: number } }

// Workflow failed — broadcast by onWorkflowComplete when result has "error" field
{ type: "workflow-error", error: string }
```

Note: `workflow-error` is broadcast from `onWorkflowComplete` (not `onWorkflowError`) because the SDK's error callback doesn't fire reliably for throws outside `step.do()`.

## Deployment

```bash
# Set the Apify API token as a secret
wrangler secret put APIFY_API_TOKEN

# Deploy (workflow binding is auto-configured via wrangler.jsonc)
wrangler deploy
```

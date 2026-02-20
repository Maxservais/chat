// Twitter/X profile scraping via Apify Tweet Scraper V2
// Actor: apidojo/tweet-scraper — $0.40 per 1000 tweets

const APIFY_ACTOR = "apidojo~tweet-scraper";
const APIFY_BASE = "https://api.apify.com/v2/acts";

export interface ScrapedTweet {
  text: string;
  createdAt: string;
  likeCount: number;
  retweetCount: number;
}

export interface ScrapeResult {
  handle: string;
  tweets: ScrapedTweet[];
  tweetCount: number;
}

/**
 * Scrape the latest tweets from a Twitter/X profile via Apify.
 * Uses the synchronous run endpoint which waits up to 300s for completion.
 */
export async function scrapeTweets(
  handle: string,
  apiToken: string,
  maxItems = 50
): Promise<ScrapeResult> {
  const cleanHandle = handle.replace(/^@/, "").trim();
  if (!cleanHandle || !/^\w{1,15}$/.test(cleanHandle)) {
    throw new Error(`Invalid Twitter handle: "${handle}"`);
  }

  const url = `${APIFY_BASE}/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${apiToken}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      twitterHandles: [cleanHandle],
      maxItems,
      sort: "Latest",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Apify API error (${response.status}): ${body.slice(0, 200)}`
    );
  }

  const raw: unknown = await response.json();

  // Apify may return an error object instead of an array (e.g. paid plan required)
  if (!Array.isArray(raw)) {
    console.error(`[twitter-scraper] Apify returned non-array:`, JSON.stringify(raw).slice(0, 500));
    throw new Error(
      `Apify returned an unexpected response. Check your Apify plan and API token.`
    );
  }

  const items = raw as Record<string, unknown>[];
  console.log(`[twitter-scraper] @${cleanHandle}: Apify returned ${items.length} items`);

  // Apify returns [{"noResults":true}] when the profile doesn't exist or has no tweets.
  // Return empty result (don't throw) so the workflow doesn't retry — retrying won't help.
  const hasNoResults = items.length === 0
    || (items.length === 1 && (items[0] as Record<string, unknown>)?.noResults === true);

  if (hasNoResults) {
    console.log(`[twitter-scraper] @${cleanHandle}: no results from Apify (profile may not exist or be private)`);
    return { handle: cleanHandle, tweets: [], tweetCount: 0 };
  }

  // Log first item's keys to understand the data shape
  const first = items[0];
  if (first) {
    console.log(`[twitter-scraper] First item keys: ${Object.keys(first).join(", ")}`);
    console.log(`[twitter-scraper] First item sample:`, JSON.stringify(first).slice(0, 500));
  }

  // Filter out non-tweet items (e.g. metadata objects without text)
  const tweetItems = items.filter((item) => item.text || item.fullText);
  console.log(`[twitter-scraper] @${cleanHandle}: ${items.length} items from Apify, ${tweetItems.length} with tweet text`);

  if (tweetItems.length === 0) {
    console.log(`[twitter-scraper] @${cleanHandle}: all items lack tweet text`);
    return { handle: cleanHandle, tweets: [], tweetCount: 0 };
  }

  const tweets: ScrapedTweet[] = tweetItems.map((item) => ({
    text: String(item.text || item.fullText || ""),
    createdAt: String(item.createdAt || ""),
    likeCount: Number(item.likeCount || item.favoriteCount || 0),
    retweetCount: Number(item.retweetCount || 0),
  }));

  if (tweets.length > 0) {
    console.log(`[twitter-scraper] Sample tweet: "${tweets[0]?.text.slice(0, 120)}"`);
  }

  return {
    handle: cleanHandle,
    tweets,
    tweetCount: tweets.length,
  };
}

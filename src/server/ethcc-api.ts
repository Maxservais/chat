// EthCC tRPC API client
// Uses ethcc-8 data for now; flip EDITION_ID to "ethcc-9" when schedule is published

const BASE_URL = "https://ethcc.io/api/trpc";
const CONFERENCE_ID = "ethcc";
const EDITION_ID = "ethcc-8"; // Change to "ethcc-9" when ready
const CACHE_TTL = 3600; // 1 hour in seconds

// --- Types ---

export interface EthccSpeaker {
  displayName: string;
  organization: string;
  pfp: string;
  slug: string;
}

export interface EthccTalk {
  id: string;
  slug: string;
  title: string;
  start: string; // ISO timestamp e.g. "2025-06-30T15:25:00"
  end: string;
  resourceId: string; // stage slug e.g. "kelly-stage"
  extendedProps: {
    applicationId?: string;
    description: string;
    track: string;
    type: string; // "Talk" | "Workshop" | "Custom"
    speakersData: EthccSpeaker[];
    hasApplicationId?: boolean;
  };
}

export interface EthccDay {
  id: string;
  date: string; // "2025-06-30"
}

export interface EthccLocation {
  id: string;
  slug: string;
  title: string;
  order: number;
  capacity: number;
  floor: string;
}

// --- KV-cached tRPC fetch ---

async function trpcQuery<T>(router: string, procedure: string, input: Record<string, unknown>): Promise<T> {
  const url = new URL(`${BASE_URL}/${router}.${procedure}`);
  url.searchParams.set("input", JSON.stringify({ json: input }));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`EthCC API error: ${res.status} ${res.statusText} for ${router}.${procedure}`);
  }

  const data = await res.json() as { result: { data: { json: T } } };
  return data.result.data.json;
}

async function cachedQuery<T>(kv: KVNamespace, cacheKey: string, fetcher: () => Promise<T>): Promise<T> {
  // Try cache first
  const cached = await kv.get(cacheKey, "json");
  if (cached) return cached as T;

  // Fetch fresh data
  const data = await fetcher();

  // Store in KV with TTL (fire-and-forget, don't block response)
  kv.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL });

  return data;
}

// --- API functions (all require KV binding) ---

export async function fetchTalks(kv: KVNamespace): Promise<EthccTalk[]> {
  return cachedQuery(kv, `talks:${CONFERENCE_ID}:${EDITION_ID}`, () =>
    trpcQuery<EthccTalk[]>("talksRouter", "getTalks", {
      conferenceId: CONFERENCE_ID,
      editionId: EDITION_ID,
    })
  );
}

export async function fetchTalkBySlug(kv: KVNamespace, slug: string): Promise<EthccTalk | null> {
  return cachedQuery(kv, `talk:${CONFERENCE_ID}:${EDITION_ID}:${slug}`, async () => {
    try {
      return await trpcQuery<EthccTalk>("talksRouter", "getTalk", {
        slug,
        conferenceId: CONFERENCE_ID,
        editionId: EDITION_ID,
      });
    } catch {
      return null;
    }
  });
}

export async function fetchDays(kv: KVNamespace): Promise<EthccDay[]> {
  return cachedQuery(kv, `days:${CONFERENCE_ID}:${EDITION_ID}`, () =>
    trpcQuery<EthccDay[]>("talksRouter", "getDays", {
      conferenceId: CONFERENCE_ID,
      editionId: EDITION_ID,
    })
  );
}

export async function fetchLocations(kv: KVNamespace): Promise<EthccLocation[]> {
  return cachedQuery(kv, `locations:${CONFERENCE_ID}:${EDITION_ID}`, () =>
    trpcQuery<EthccLocation[]>("talksRouter", "getLocations", {
      conferenceId: CONFERENCE_ID,
      editionId: EDITION_ID,
    })
  );
}

// --- Search & filter helpers ---

const REAL_TALK_TYPES = new Set(["Talk", "Workshop", "Demo"]);

/** Filter out admin items (lunch, doors, etc.) -- keep only Talk and Workshop */
export function filterRealTalks(talks: EthccTalk[]): EthccTalk[] {
  return talks.filter((t) => REAL_TALK_TYPES.has(t.extendedProps.type));
}

/** Case-insensitive search: splits query into words (3+ chars), matches if ANY word hits.
 *  Title/track/speaker matches are weighted higher than description matches. */
export function searchTalksLocal(talks: EthccTalk[], query: string): EthccTalk[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return talks;

  const scored = talks
    .map((t) => {
      const title = t.title.toLowerCase();
      const track = t.extendedProps.track.toLowerCase();
      const speakers = t.extendedProps.speakersData
        .map((s) => `${s.displayName} ${s.organization}`)
        .join(" ")
        .toLowerCase();
      const desc = (t.extendedProps.description ?? "").toLowerCase();

      let score = 0;
      for (const w of words) {
        if (title.includes(w)) score += 3;
        else if (track.includes(w)) score += 2;
        else if (speakers.includes(w)) score += 2;
        else if (desc.includes(w)) score += 1;
      }
      return { talk: t, score };
    })
    .filter(({ score }) => score > 0);

  scored.sort((a, b) => b.score - a.score || a.talk.start.localeCompare(b.talk.start));
  return scored.map(({ talk }) => talk);
}

export function filterByTrack(talks: EthccTalk[], track: string): EthccTalk[] {
  const t = track.toLowerCase();
  return talks.filter((talk) => talk.extendedProps.track.toLowerCase().includes(t));
}

export function filterByDate(talks: EthccTalk[], date: string): EthccTalk[] {
  return talks.filter((t) => t.start.startsWith(date));
}

/** Get all unique tracks from the talk list */
export function getUniqueTracks(talks: EthccTalk[]): string[] {
  const tracks = new Set(talks.map((t) => t.extendedProps.track));
  return [...tracks].sort();
}

/** Extract HH:MM from an ISO timestamp string (avoids Date timezone issues on Workers) */
function timeFromISO(iso: string): string {
  const time = iso.split("T")[1];
  return time ? time.slice(0, 5) : "";
}

/** Format a talk for display in AI responses (compact, saves tokens) */
export function formatTalkForAI(talk: EthccTalk): Record<string, unknown> {
  return {
    title: talk.title,
    slug: talk.slug,
    track: talk.extendedProps.track,
    date: talk.start.split("T")[0],
    time: `${timeFromISO(talk.start)}-${timeFromISO(talk.end)}`,
    start: talk.start,
    end: talk.end,
    speakers: talk.extendedProps.speakersData.map((s) => `${s.displayName} (${s.organization})`).join(", "),
    description: (talk.extendedProps.description ?? "").slice(0, 120),
    room: talk.resourceId,
  };
}

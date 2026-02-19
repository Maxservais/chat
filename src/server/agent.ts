import { createWorkersAI } from "workers-ai-provider";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet
} from "ai";
import { z } from "zod";
import {
  fetchTalks,
  fetchTalkBySlug,
  fetchDays,
  fetchLocations,
  filterRealTalks,
  searchTalksLocal,
  filterByTrack,
  filterByDate,
  getUniqueTracks,
  formatTalkForAI,
} from "./ethcc-api";

/** Escape special ICS characters */
function escapeICS(s: string): string {
  return s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

const VTIMEZONE_EUROPE_PARIS = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Paris",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "ethcc-planner" },
    });
    const kv = this.env.ETHCC_CACHE;

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are the EthCC Planner, a concise AI assistant that helps attendees plan their EthCC schedule.

Conference: EthCC[8], June 30 - July 3 2025, Palais des Festivals, Cannes, France.

Available tracks: Core Protocol | DeFi | Zero Knowledge & Cryptography | Security | Layer 2s, Layers above and beyond | Cypherpunk & Privacy | Token Engineering | For Developers and Users | Product & Marketers | The Unexpected | Real World Ethereum | Entertainment | Governance

STRICT RULES:
1. Be SHORT. No filler ("Let me search", "Great question!", "I parsed the tool output"). Just answer.
2. Max 10 talks in a markdown table: Date | Time | Title | Speaker | Room. If more exist, say the total and ask the user to filter.
3. Flag time conflicts.
4. Do NOT echo tool output — the UI already shows it.
5. Do NOT show raw ICS content. After generating a calendar, just say "Your calendar is ready — use the download button above."
6. NEVER invent, guess, or fabricate talk data. Every talk you mention MUST come from a tool result. If you don't have the data, call the tool.
7. When the user asks to "pick favorites" or "narrow down" from results you already have in context, reason about the data yourself.
8. When the user asks for "more", "next", or "remaining" talks, call searchTalks again with the offset parameter to paginate. Example: first call returned 10 of 35 → next call uses offset:10.

Tool rules (CRITICAL — violating these is an error):
- You may call searchTalks AT MOST ONCE per user message. NEVER call it twice in the same response.
- Use the "track" parameter when the user asks for a specific track. Map: "DeFi talks" → track:"DeFi", "L2 talks" → track:"Layer 2", "ZK talks" → track:"Zero Knowledge", "security talks" → track:"Security".
- Use "query" ONLY for free-text keyword search (e.g. "Vitalik", "MEV", "account abstraction").
- searchTalks results already contain title, start, end, room, speakers, slug. Use this data DIRECTLY for generateCalendarFile — do NOT call getTalkDetails first.
- Only call getTalkDetails when the user wants details about ONE specific talk. Use the exact slug from searchTalks.
- Only call getConferenceInfo when the user explicitly asks about tracks, days, or rooms.

Current date: ${new Date().toISOString().split("T")[0]}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        searchTalks: tool({
          description: "Search EthCC talks by keyword, track, date, or type. Use this when the user asks about talks, sessions, or wants recommendations based on their interests. Use offset to paginate when the user asks for 'more' or 'next' results.",
          inputSchema: z.object({
            query: z.string().optional().describe("Free-text search (e.g. 'ZK proofs', 'DeFi yields', 'Vitalik')"),
            track: z.string().optional().describe("Filter by track name (e.g. 'DeFi', 'Zero Knowledge & Cryptography', 'Security')"),
            date: z.string().optional().describe("Filter by date in YYYY-MM-DD format (2025-06-30 to 2025-07-03)"),
            limit: z.number().optional().default(10).describe("Max results to return"),
            offset: z.number().optional().default(0).describe("Number of results to skip (for pagination). E.g. if you already showed 10, use offset:10 to get the next batch."),
          }),
          execute: async ({ query, track, date, limit, offset }) => {
            let talks = await fetchTalks(kv);
            talks = filterRealTalks(talks);

            if (date) talks = filterByDate(talks, date);
            if (track) talks = filterByTrack(talks, track);
            if (query) talks = searchTalksLocal(talks, query);

            talks.sort((a, b) => a.start.localeCompare(b.start));

            const paged = talks.slice(offset, offset + limit);
            const results = paged.map(formatTalkForAI);
            return results.length > 0
              ? { talks: results, totalMatches: talks.length, showing: results.length, offset }
              : "No talks found matching your criteria. Try broadening your search or check available tracks with getConferenceInfo.";
          },
        }),

        getTalkDetails: tool({
          description: "Get full details for a specific talk by its slug. Use this when the user wants more info about a particular talk.",
          inputSchema: z.object({
            slug: z.string().describe("The talk slug (URL-friendly name, e.g. 'aave-v4-supercharged-defi')"),
          }),
          execute: async ({ slug }) => {
            const talk = await fetchTalkBySlug(kv, slug);
            if (!talk) return "Talk not found. Check the slug and try again.";
            return {
              title: talk.title,
              description: talk.extendedProps.description,
              track: talk.extendedProps.track,
              type: talk.extendedProps.type,
              date: talk.start.split("T")[0],
              start: talk.start,
              end: talk.end,
              speakers: talk.extendedProps.speakersData.map((s) => ({
                name: s.displayName,
                organization: s.organization,
              })),
              room: talk.resourceId,
              slug: talk.slug,
            };
          },
        }),

        getConferenceInfo: tool({
          description: "Get EthCC conference information: available tracks, days, and venues. Use when the user asks about the conference structure.",
          inputSchema: z.object({}),
          execute: async () => {
            const [talks, days, locations] = await Promise.all([
              fetchTalks(kv).then(filterRealTalks),
              fetchDays(kv),
              fetchLocations(kv),
            ]);
            return {
              tracks: getUniqueTracks(talks),
              days: days.map((d) => d.date),
              venues: locations.map((l) => ({ name: l.title, floor: l.floor, capacity: l.capacity })),
              totalTalks: talks.length,
            };
          },
        }),

        generateCalendarFile: tool({
          description: "Generate an .ics calendar file for selected EthCC talks. Use data directly from searchTalks output (title, start, end, room, speakers) — no need to call getTalkDetails first.",
          inputSchema: z.object({
            talks: z.array(z.object({
              title: z.string(),
              start: z.string().describe("ISO timestamp e.g. 2025-06-30T15:25:00"),
              end: z.string().describe("ISO timestamp e.g. 2025-06-30T15:45:00"),
              room: z.string().optional(),
              speakers: z.string().optional().describe("Comma-separated speaker names, e.g. 'Alice (Org1), Bob (Org2)'"),
              description: z.string().optional(),
            })).describe("Array of talks to add to the calendar"),
          }),
          execute: async ({ talks }) => {
            const events = talks.map((talk) => {
              const dtStart = talk.start.replace(/[-:]/g, "");
              const dtEnd = talk.end.replace(/[-:]/g, "");
              const uid = `${dtStart}-${talk.title.replace(/\s+/g, "-").toLowerCase().slice(0, 40)}@ethcc-planner`;
              const descParts = [
                talk.description,
                talk.speakers ? `Speakers: ${talk.speakers}` : undefined,
              ].filter(Boolean);

              return [
                "BEGIN:VEVENT",
                `UID:${uid}`,
                `DTSTART;TZID=Europe/Paris:${dtStart}`,
                `DTEND;TZID=Europe/Paris:${dtEnd}`,
                `SUMMARY:${escapeICS(talk.title)}`,
                descParts.length ? `DESCRIPTION:${escapeICS(descParts.join("\n"))}` : "",
                `LOCATION:${escapeICS(`${talk.room ? `${talk.room}, ` : ""}Palais des Festivals, Cannes`)}`,
                "END:VEVENT",
              ].filter(Boolean).join("\r\n");
            });

            const ics = [
              "BEGIN:VCALENDAR",
              "VERSION:2.0",
              "PRODID:-//EthCC Planner//EN",
              "CALSCALE:GREGORIAN",
              "METHOD:PUBLISH",
              "X-WR-CALNAME:My EthCC Schedule",
              "X-WR-TIMEZONE:Europe/Paris",
              VTIMEZONE_EUROPE_PARIS,
              ...events,
              "END:VCALENDAR",
            ].join("\r\n");

            return {
              icsContent: ics,
              eventCount: talks.length,
              message: `Generated calendar with ${talks.length} event(s). Click the download button to save the .ics file.`,
            };
          },
        }),
      },
      maxOutputTokens: 2048,
      onFinish,
      stopWhen: stepCountIs(3),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

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
    const workersai = createWorkersAI({ binding: this.env.AI });
    const kv = this.env.ETHCC_CACHE;

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are the EthCC Planner, a concise AI assistant that helps attendees plan their EthCC schedule.

Conference: EthCC[8], June 30 - July 3 2025, Palais des Festivals, Cannes, France.

Available tracks: Core Protocol | DeFi | Zero Knowledge & Cryptography | Security | Layer 2s, Layers above and beyond | Cypherpunk & Privacy | Token Engineering | For Developers and Users | Product & Marketers | The Unexpected | Real World Ethereum | Entertainment | Governance

IMPORTANT — Response style:
- Be SHORT and direct. No filler, no "Let me search", no "Great question!"
- Show at most 10 talks in a markdown table. NEVER output more than 10 rows. If there are more results, mention the total and ask the user to filter further.
- Table columns: Date | Time | Title | Speaker | Room
- Flag time conflicts clearly
- Do NOT repeat or echo tool output — the UI already shows tool results. Just present your curated summary.
- Do NOT show raw ICS/calendar content — the UI has a download button for that
- After generating a calendar file, just say "Your calendar is ready — use the download button above"
- When the user asks you to narrow down or filter results you already have, reason about the data yourself — do NOT make another search call

Tool usage:
- ALWAYS use the "track" parameter when the user asks for talks in a specific track. Map user intent to the closest track name above. Examples: "DeFi talks" → track:"DeFi", "L2 talks" → track:"Layer 2", "ZK talks" → track:"Zero Knowledge", "security talks" → track:"Security".
- Use "query" ONLY for free-text keyword search that doesn't map to a track (e.g. "Vitalik", "MEV", "account abstraction").
- Make ONE search call. Never retry or make a second search call.
- searchTalks results already include title, start, end, room, speakers, and slug. Use this data DIRECTLY to generate calendar files — do NOT call getTalkDetails first.
- Only use getTalkDetails when the user asks for more info about a specific talk, and ALWAYS use the exact slug from the searchTalks output. Never guess or construct slugs.
- Only call getConferenceInfo when the user explicitly asks about tracks, days, or rooms.
- The query parameter supports multi-word search (each word matched independently, words under 3 chars are ignored). Use short, targeted keywords.

Current date: ${new Date().toISOString().split("T")[0]}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        searchTalks: tool({
          description: "Search EthCC talks by keyword, track, date, or type. Use this when the user asks about talks, sessions, or wants recommendations based on their interests.",
          inputSchema: z.object({
            query: z.string().optional().describe("Free-text search (e.g. 'ZK proofs', 'DeFi yields', 'Vitalik')"),
            track: z.string().optional().describe("Filter by track name (e.g. 'DeFi', 'Zero Knowledge & Cryptography', 'Security')"),
            date: z.string().optional().describe("Filter by date in YYYY-MM-DD format (2025-06-30 to 2025-07-03)"),
            limit: z.number().optional().default(15).describe("Max results to return"),
          }),
          execute: async ({ query, track, date, limit }) => {
            let talks = await fetchTalks(kv);
            talks = filterRealTalks(talks);

            if (date) talks = filterByDate(talks, date);
            if (track) talks = filterByTrack(talks, track);
            if (query) talks = searchTalksLocal(talks, query);

            talks.sort((a, b) => a.start.localeCompare(b.start));

            const results = talks.slice(0, limit).map(formatTalkForAI);
            return results.length > 0
              ? { talks: results, totalMatches: talks.length, showing: results.length }
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
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

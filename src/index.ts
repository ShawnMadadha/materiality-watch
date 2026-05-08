#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ApifyClient, ScheduleActions } from "apify-client";
import { z } from "zod";

// --------------- Config ---------------

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error(
    "Missing APIFY_TOKEN. Get one at https://console.apify.com/account/integrations"
  );
  process.exit(1);
}

const apify = new ApifyClient({ token: TOKEN });

// --------------- Rate limiting (growth hook) ---------------

const FREE_TIER_LIMIT = 5;
const callCounts = new Map<string, number>();

function checkRateLimit(fingerprint: string | undefined): void {
  if (!fingerprint) return;
  const count = callCounts.get(fingerprint) ?? 0;
  if (count >= FREE_TIER_LIMIT) {
    throw new Error(
      `Free tier exhausted (${FREE_TIER_LIMIT} calls/day). ` +
        "Set APIFY_TOKEN from https://console.apify.com to continue. " +
        "Free Apify accounts get $5/month in credits."
    );
  }
  callCounts.set(fingerprint, count + 1);
}

// --------------- Schemas ---------------

const scrapeInput = z.object({
  url: z.string().url(),
  mode: z
    .enum(["fast", "rendered", "deep"])
    .default("fast"),
  max_chars: z.number().default(10_000),
});

const webSearchInput = z.object({
  query: z.string(),
  max_results: z.number().min(1).max(20).default(5),
  max_chars: z.number().default(8_000),
});

const webResearchInput = z.object({
  query: z.string(),
  max_sources: z.number().min(1).max(10).default(3),
  max_chars: z.number().default(15_000),
});

const monitorUrlInput = z.object({
  urls: z.array(z.url()).min(1),
  criteria: z.string(),
  schedule_interval: z
    .enum(["hourly", "daily", "weekly"])
    .default("daily"),
  webhook_url: z.url().optional(),
});

const extractStructuredInput = z.object({
  url: z.string(),
  schema: z.record(z.string(), z.unknown()),
  max_chars: z.number().default(10_000),
});

const findActorInput = z.object({
  query: z.string(),
  max_results: z.number().min(1).max(20).default(5),
});

const runActorInput = z.object({
  actor_id: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
  timeout_secs: z.number().min(1).max(300).default(120),
  max_items: z.number().min(1).max(1000).default(100),
});

// --------------- Tool implementations ---------------

async function scrapeUrl(args: z.infer<typeof scrapeInput>) {
  const actorId =
    args.mode === "rendered"
      ? "apify/puppeteer-scraper"
      : "apify/website-content-crawler";

  const input: Record<string, unknown> =
    args.mode === "rendered"
      ? {
          startUrls: [{ url: args.url }],
          pageFunction: [
            "async function pageFunction(context) {",
            "  const { page } = context;",
            "  await page.waitForTimeout(3000);",
            "  const text = await page.evaluate(() => document.body.innerText);",
            "  return { url: page.url(), text };",
            "}",
          ].join("\n"),
        }
      : {
          startUrls: [{ url: args.url }],
          maxCrawlDepth: args.mode === "deep" ? 2 : 0,
          maxCrawlPages: args.mode === "deep" ? 10 : 1,
          saveMarkdown: true,
        };

  const run = await apify.actor(actorId).call(input);
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  const content = items
    .map((i: Record<string, unknown>) =>
      String(i.markdown || i.text || "")
    )
    .join("\n\n---\n\n")
    .slice(0, args.max_chars);

  return { url: args.url, mode: args.mode, pages: items.length, content };
}

async function webSearch(args: z.infer<typeof webSearchInput>) {
  const run = await apify.actor("apify/google-search-scraper").call({
    queries: args.query,
    maxPagesPerQuery: 1,
    resultsPerPage: args.max_results,
  });

  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  const results = (
    items[0] as Record<string, unknown> & {
      organicResults?: Array<Record<string, unknown>>;
    }
  )?.organicResults
    ?.slice(0, args.max_results)
    .map(
      (r: Record<string, unknown>, i: number) =>
        `### ${i + 1}. ${r.title}\n**URL:** ${r.url}\n${r.description || ""}`
    );

  const content = (results ?? ["No results found."]).join("\n\n").slice(0, args.max_chars);

  return { query: args.query, result_count: results?.length ?? 0, content };
}

async function webResearch(args: z.infer<typeof webResearchInput>) {
  const searchResult = await webSearch({
    query: args.query,
    max_results: args.max_sources,
    max_chars: args.max_chars,
  });

  const urlPattern = /\*\*URL:\*\* (https?:\/\/[^\s]+)/g;
  const urls: string[] = [];
  let match;
  while ((match = urlPattern.exec(searchResult.content)) !== null) {
    if (match[1]) urls.push(match[1]);
  }

  const sources: Array<{ url: string; content: string }> = [];
  const charsPerSource = Math.floor(args.max_chars / Math.max(urls.length, 1));

  for (const url of urls.slice(0, args.max_sources)) {
    try {
      const scraped = await scrapeUrl({
        url,
        mode: "fast",
        max_chars: charsPerSource,
      });
      sources.push({ url, content: scraped.content });
    } catch {
      sources.push({ url, content: "(failed to scrape)" });
    }
  }

  const content = sources
    .map((s, i) => `## Source ${i + 1}: ${s.url}\n\n${s.content}`)
    .join("\n\n---\n\n")
    .slice(0, args.max_chars);

  return {
    query: args.query,
    sources_scraped: sources.length,
    search_results: searchResult.content,
    content,
  };
}

async function monitorUrl(args: z.infer<typeof monitorUrlInput>) {
  const cronExpression = {
    hourly: "0 * * * *",
    daily: "0 8 * * *",
    weekly: "0 8 * * 1",
  }[args.schedule_interval];

  const actorInput: Record<string, unknown> = {
    urls: args.urls,
    criteria: args.criteria,
    emit_digest: true,
  };
  if (args.webhook_url) {
    actorInput.webhook_url = args.webhook_url;
  }

  // Run the Materiality Watch actor once immediately to establish baselines
  const run = await apify
    .actor("materiality-watch")
    .call(actorInput);
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  // Create a schedule for recurring runs
  const schedule = await apify.schedules().create({
    name: `materiality-watch-${Date.now()}`,
    cronExpression,
    isEnabled: true,
    actions: [
      {
        type: ScheduleActions.RunActor,
        actorId: "materiality-watch",
        runInput: {
          body: JSON.stringify(actorInput),
          contentType: "application/json",
        },
      },
    ],
  });

  return {
    schedule_id: schedule.id,
    schedule_name: schedule.name,
    cron: cronExpression,
    interval: args.schedule_interval,
    urls_watched: args.urls.length,
    initial_run_id: run.id,
    initial_results: items.length,
    message: `Monitoring ${args.urls.length} URL(s) ${args.schedule_interval}. Schedule ID: ${schedule.id}. First run established baselines — changes will be detected on subsequent runs.`,
  };
}

async function extractStructured(args: z.infer<typeof extractStructuredInput>) {
  const scraped = await scrapeUrl({
    url: args.url,
    mode: "fast",
    max_chars: args.max_chars,
  });

  const schemaStr = JSON.stringify(args.schema, null, 2);
  const prompt =
    `Extract structured data from the following webpage content according to this JSON schema:\n\n` +
    `SCHEMA:\n${schemaStr}\n\n` +
    `CONTENT:\n${scraped.content}\n\n` +
    `Return ONLY a valid JSON object matching the schema. No prose, no code fences.`;

  const run = await apify.actor("apify/website-content-crawler").call({
    startUrls: [{ url: args.url }],
    maxCrawlPages: 1,
    saveMarkdown: true,
  });

  const { items } = await apify.dataset(run.defaultDatasetId).listItems();
  const pageContent = items
    .map((i: Record<string, unknown>) => String(i.markdown || i.text || ""))
    .join("\n")
    .slice(0, args.max_chars);

  return {
    url: args.url,
    schema: args.schema,
    raw_content: pageContent,
    extraction_prompt: prompt,
    message:
      "Content scraped. The extraction prompt above is ready for your LLM to process. " +
      "Pass the prompt to Claude or another LLM to get the structured output matching your schema.",
  };
}

async function findActor(args: z.infer<typeof findActorInput>) {
  const result = await apify.store().list({
    search: args.query,
    limit: args.max_results,
  });

  const actors = result.items.map((a) => ({
    id: a.id,
    name: a.name,
    username: a.username,
    title: a.title,
    description: String(a.description || "").slice(0, 200),
    stats: a.stats,
  }));

  const content = actors
    .map(
      (a, i) =>
        `### ${i + 1}. ${a.title} (${a.username}/${a.name})\n${a.description}`
    )
    .join("\n\n");

  return {
    query: args.query,
    result_count: actors.length,
    actors,
    content,
  };
}

async function runActor(args: z.infer<typeof runActorInput>) {
  const run = await apify.actor(args.actor_id).call(args.input, {
    timeout: args.timeout_secs,
  });

  const { items } = await apify
    .dataset(run.defaultDatasetId)
    .listItems({ limit: args.max_items });

  return {
    actor_id: args.actor_id,
    run_id: run.id,
    status: run.status,
    items_count: items.length,
    items,
  };
}

// --------------- MCP server setup ---------------

const tools = [
  {
    name: "scrape_url",
    description:
      "Fetch and clean text content from a URL. Returns markdown-formatted content. " +
      "Use mode=fast for static pages, rendered for JS-heavy SPAs, deep to follow links.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", format: "uri", description: "URL to scrape" },
        mode: {
          type: "string",
          enum: ["fast", "rendered", "deep"],
          default: "fast",
          description: "fast: static HTML, rendered: JS-heavy SPA, deep: follow links",
        },
        max_chars: {
          type: "number",
          default: 10000,
          description: "Maximum characters to return",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web and return clean, formatted results with titles, URLs, and descriptions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: {
          type: "number",
          default: 5,
          minimum: 1,
          maximum: 20,
          description: "Number of results to return",
        },
        max_chars: {
          type: "number",
          default: 8000,
          description: "Maximum characters to return",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_research",
    description:
      "Deep research: searches the web, scrapes top results, and returns combined content " +
      "from multiple sources. Use for questions that need information from several pages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Research question" },
        max_sources: {
          type: "number",
          default: 3,
          minimum: 1,
          maximum: 10,
          description: "Number of sources to scrape",
        },
        max_chars: {
          type: "number",
          default: 15000,
          description: "Maximum characters to return",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "monitor_url",
    description:
      "Schedule recurring monitoring for a list of URLs. Detects changes and filters them " +
      "against your plain-English criteria. Only alerts on material changes. " +
      "Optionally fires a webhook with a consolidated digest on each run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urls: {
          type: "array",
          items: { type: "string", format: "uri" },
          description: "URLs to monitor",
        },
        criteria: {
          type: "string",
          description:
            "Plain-English description of what changes matter. E.g. 'pricing changes, API deprecations, leadership changes'",
        },
        schedule_interval: {
          type: "string",
          enum: ["hourly", "daily", "weekly"],
          default: "daily",
          description: "How often to check",
        },
        webhook_url: {
          type: "string",
          format: "uri",
          description: "Optional webhook URL to POST results to",
        },
      },
      required: ["urls", "criteria"],
    },
  },
  {
    name: "extract_structured",
    description:
      "Scrape a URL and prepare content for structured data extraction against a JSON schema. " +
      "Returns the scraped content and an extraction prompt ready for LLM processing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", format: "uri", description: "URL to extract data from" },
        schema: {
          type: "object",
          description:
            "JSON schema describing the data to extract. E.g. { \"company_name\": \"string\", \"pricing_tiers\": [{ \"name\": \"string\", \"price\": \"number\" }] }",
        },
        max_chars: {
          type: "number",
          default: 10000,
          description: "Maximum content characters to process",
        },
      },
      required: ["url", "schema"],
    },
  },
  {
    name: "find_actor",
    description:
      "Search the Apify Store for actors. Use this to discover specialized scrapers, " +
      "crawlers, and automation tools. Power-user escape hatch.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query for the Apify Store" },
        max_results: {
          type: "number",
          default: 5,
          minimum: 1,
          maximum: 20,
          description: "Number of results to return",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "run_actor",
    description:
      "Run any Apify actor by ID with custom input. Power-user escape hatch for actors " +
      "not covered by the other tools. Use find_actor first to discover actor IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        actor_id: {
          type: "string",
          description: "Actor ID, e.g. 'apify/web-scraper' or 'username/actor-name'",
        },
        input: {
          type: "object",
          description: "Actor input (varies per actor — check actor docs)",
        },
        timeout_secs: {
          type: "number",
          default: 120,
          minimum: 1,
          maximum: 300,
          description: "Max seconds to wait for the run to finish",
        },
        max_items: {
          type: "number",
          default: 100,
          minimum: 1,
          maximum: 1000,
          description: "Max dataset items to return",
        },
      },
      required: ["actor_id"],
    },
  },
];

const server = new Server(
  { name: "apify-agent-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const { name, arguments: args } = req.params;

    // Rate-limit free-tier users (no APIFY_TOKEN = shared token path)
    const fingerprint = (args as Record<string, unknown> | undefined)?._fingerprint as
      | string
      | undefined;
    if (process.env.FREE_TIER === "true") {
      checkRateLimit(fingerprint);
    }

    let result: unknown;

    switch (name) {
      case "scrape_url":
        result = await scrapeUrl(scrapeInput.parse(args));
        break;
      case "web_search":
        result = await webSearch(webSearchInput.parse(args));
        break;
      case "web_research":
        result = await webResearch(webResearchInput.parse(args));
        break;
      case "monitor_url":
        result = await monitorUrl(monitorUrlInput.parse(args));
        break;
      case "extract_structured":
        result = await extractStructured(extractStructuredInput.parse(args));
        break;
      case "find_actor":
        result = await findActor(findActorInput.parse(args));
        break;
      case "run_actor":
        result = await runActor(runActorInput.parse(args));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

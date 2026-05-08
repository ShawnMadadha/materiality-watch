# Materiality Watch

### AI-powered website change monitoring that only alerts you on what actually matters.

Every change monitor floods you with noise. Footer edits, ad rotation, timestamp updates, hero image swaps. You set up monitoring to stay informed — instead you learn to ignore it.

**Materiality Watch flips the model.** You describe, in plain English, what kinds of changes you care about. Claude AI evaluates every diff against *your* criteria and suppresses everything else.

> *"Pricing changes, API deprecations, leadership changes. Ignore blog posts, copy polish, and navigation tweaks."*

Same page. Same diff. Different verdict for different users.

---

## Why this exists

There are 10+ website change monitors on the [Apify Store](https://apify.com/store). They all do the same thing: scrape a URL, diff it, summarize with generic AI. The category exists but is unwon — every competitor sits at 2-29 total users.

The gap: **nobody lets the user define what "material" means.**

| | Generic monitors | Materiality Watch |
|---|---|---|
| **Filter logic** | "Is this significant?" (generic) | Your criteria in plain English |
| **URLs per run** | Usually 1 | 1-50 (portfolio mode) |
| **Output** | One alert per URL | One consolidated digest |
| **History** | Last snapshot only | Per-URL timeline (50 events) |
| **Webhook** | Per-URL fire | Single consolidated payload |
| **False positives** | High | Low (criteria-filtered) |

---

## How it works

```
URLs + Criteria ──> Fetch ──> Diff ──> Claude AI Filter ──> Material changes only
                                              │
                                    "Does this match the
                                     user's criteria?"
                                              │
                                     ┌────────┴────────┐
                                     │                  │
                                   YES                 NO
                              ┌─────┴─────┐       (suppressed
                              │           │        silently)
                          Per-change   Consolidated
                           records      digest
                              │           │
                              └─────┬─────┘
                                    │
                              Webhook POST
                            (single fire/run)
```

On each scheduled run:

1. **Fetch** every URL concurrently, extract clean text via `trafilatura`
2. **Diff** against the last snapshot in Apify's key-value store
3. **Classify** with Claude Haiku — evaluate each diff against your criteria, score significance 1-5, tag categories
4. **Suppress** immaterial changes silently
5. **Record** material changes to the dataset with structured metadata
6. **Digest** — Claude writes a 3-6 sentence executive summary across all changes
7. **Webhook** — one consolidated POST per run (not one per URL)
8. **Timeline** — append to per-URL change history for audit trail

---

## Use cases

| Who | Watches | Criteria example |
|---|---|---|
| **Founders** | Competitor pricing pages | *"Pricing changes, plan name or tier changes, new product launches"* |
| **DevRel** | Upstream API docs | *"API deprecations, breaking changes, new endpoints, schema changes"* |
| **Compliance** | Regulatory bodies, T&C pages | *"New requirements, enforcement actions, regulatory language changes"* |
| **Growth** | Competitor landing pages | *"Value prop changes, CTA changes, social proof updates"* |
| **Security** | Vendor security pages | *"New vulnerabilities, policy changes, incident disclosures"* |

---

## Quick start

### Input

```json
{
  "urls": [
    "https://www.anthropic.com/pricing",
    "https://openai.com/api/pricing/"
  ],
  "criteria": "Pricing changes, model availability, rate limit changes. Ignore blog posts and footer changes.",
  "anthropic_api_key": "sk-ant-...",
  "emit_digest": true
}
```

### Run locally

```bash
apify run --purge
```

The first run establishes baselines (no alerts). Subsequent runs detect and classify changes.

### Deploy

```bash
apify push
```

Then schedule in the [Apify Console](https://console.apify.com) — e.g., every 6 hours.

---

## Output

### Per material change

```json
{
  "url": "https://example.com/pricing",
  "detected_at": "2026-05-07T14:00:00+00:00",
  "is_material": true,
  "significance": 4,
  "categories": ["pricing", "plan-name"],
  "summary": "The 'Pro' tier was renamed to 'Team' and price increased from $20 to $25/month.",
  "diff_excerpt": "-Pro Plan — $20/month\n+Team Plan — $25/month"
}
```

### Consolidated digest

```json
{
  "type": "digest",
  "n_changes": 3,
  "digest": "Anthropic raised Pro to $25 and renamed it to Team. OpenAI added a new tier. No changes to Mistral pricing."
}
```

---

## Architecture

```
src/
├── main.py          # Actor logic — fetch, diff, classify, digest
├── __main__.py      # Entrypoint
└── __init__.py

.actor/
├── actor.json       # Apify actor configuration
├── input_schema.json
└── Dockerfile
```

**Stack:** Python 3.13 + Apify SDK + httpx + trafilatura + Claude API (Haiku)

**Cost:** ~$0.02/run + ~$0.001-0.003 per URL in Anthropic API costs. A portfolio of 20 URLs checked 4x/day runs about $5/month.

---

## Input reference

| Field | Required | Default | Description |
|---|---|---|---|
| `urls` | Yes | — | URLs to monitor (1-50) |
| `criteria` | No | General materiality rules | Plain-English filter for what matters |
| `anthropic_api_key` | No | `ANTHROPIC_API_KEY` env var | Required for AI filtering |
| `webhook_url` | No | — | Consolidated POST on material changes |
| `emit_digest` | No | `true` | Generate executive digest per run |
| `classify_model` | No | `claude-haiku-4-5-20251001` | Model for diff classification |
| `digest_model` | No | `claude-haiku-4-5-20251001` | Model for digest generation |

---

## MCP Server (Agent Bridge)

This repo also includes an MCP server (`src/index.ts`) that wraps Apify actors as agent-friendly tools — including `monitor_url` which routes to this actor. See the [build plan](https://github.com/ShawnMadadha/materiality-watch#mcp-server-agent-bridge) for details on the 7 high-level tools:

`scrape_url` · `web_search` · `web_research` · `monitor_url` · `extract_structured` · `find_actor` · `run_actor`

---

## Roadmap

- [ ] CSS selector / XPath restriction (diff only a region of the page)
- [ ] Image diffing for visual changes
- [ ] RSS feed ingestion alongside URLs
- [ ] Slack / Discord webhook formatting
- [ ] Named watchlists with persistent config

---

## License

MIT

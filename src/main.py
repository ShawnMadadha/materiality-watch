"""
Materiality Watch — Apify Actor

Differentiation vs. existing marketplace change monitors:
  - PORTFOLIO: monitors many URLs in one scheduled run (not one URL at a time)
  - CRITERIA: user describes in plain English what counts as material; Claude
    filters changes against that, instead of generic "significance 1-5"
  - TIMELINE: each URL has a per-URL change history in the KV store, not just
    a last-snapshot overwrite
  - DIGEST: outputs one consolidated digest per run alongside per-URL records,
    so downstream agents/humans get a single signal not 50 alerts

Designed to run on a schedule. On each run it processes every URL in the
watchlist concurrently, classifies each diff against the user's criteria,
and emits both per-change records and a consolidated digest.
"""

from __future__ import annotations

import os
import json
import hashlib
import difflib
import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx
import trafilatura
from apify import Actor


CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_CLASSIFY_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_DIGEST_MODEL = "claude-haiku-4-5-20251001"

CONCURRENCY = 5  # parallel URL fetches per run
TIMELINE_LIMIT = 50  # cap per-URL history entries

CLASSIFY_PROMPT = """You are a materiality classifier for a webpage change monitor.

The user has described, in their own words, what kinds of changes matter to them.
Your job is to evaluate ONE diff against THEIR criteria — not a generic notion of
"significance." A change can be large in bytes but immaterial to this user, and
vice versa.

USER'S MATERIALITY CRITERIA (verbatim):
\"\"\"
{criteria}
\"\"\"

URL: {url}

UNIFIED DIFF (truncated):
{diff}

Output ONLY this JSON object — no prose, no code fences:
{{
  "is_material": <true|false — true ONLY if the change clearly matches the user's criteria>,
  "significance": <integer 1-5 calibrated against the user's criteria; 5 = exactly the kind of thing they're watching for>,
  "categories": [<one or more short tags drawn from the diff content, e.g. "pricing", "personnel", "api-change", "policy", "copy", "navigation">],
  "summary": "<1-2 sentence plain-English description of what changed and why it matches (or fails) the user's criteria>"
}}

Be strict. Boilerplate edits, timestamps, view counters, ad rotation, and copy
polish are NOT material unless the user's criteria explicitly include them."""


DIGEST_PROMPT = """You are writing a consolidated digest of webpage changes detected this run.

USER'S MATERIALITY CRITERIA:
\"\"\"
{criteria}
\"\"\"

MATERIAL CHANGES DETECTED ({n} total):
{changes_block}

Write a 3-6 sentence executive digest. Lead with whatever is most consequential
to this user. Group related changes when natural. Do not use bullet points
unless they genuinely improve clarity. Do not pad. If a change is uncertain,
say so. End with no call to action."""


# ---------- Fetch + extract ----------

async def fetch_clean(client: httpx.AsyncClient, url: str) -> str:
    """Fetch URL and extract main text content as markdown."""
    resp = await client.get(
        url,
        headers={"User-Agent": "ApifyMaterialityWatch/0.1 (+https://apify.com)"},
        timeout=30,
    )
    resp.raise_for_status()
    extracted = trafilatura.extract(
        resp.text,
        include_comments=False,
        include_tables=True,
        favor_recall=True,
        output_format="markdown",
    )
    if not extracted or len(extracted.strip()) < 50:
        return resp.text  # fall back to raw — better than nothing
    return extracted.strip()


def compute_diff(prev: str, curr: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            prev.splitlines(),
            curr.splitlines(),
            fromfile="previous",
            tofile="current",
            lineterm="",
            n=2,
        )
    )


# ---------- Claude ----------

async def call_claude(
    client: httpx.AsyncClient,
    api_key: str,
    model: str,
    prompt: str,
    max_tokens: int = 800,
) -> str:
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    resp = await client.post(CLAUDE_API_URL, headers=headers, json=body, timeout=60)
    resp.raise_for_status()
    return resp.json()["content"][0]["text"].strip()


def parse_json_response(text: str) -> dict[str, Any]:
    """Tolerant JSON parser — strips code fences if Claude adds them."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)


async def classify_diff(
    http: httpx.AsyncClient,
    api_key: str,
    model: str,
    url: str,
    criteria: str,
    diff: str,
) -> dict[str, Any]:
    prompt = CLASSIFY_PROMPT.format(criteria=criteria, url=url, diff=diff[:8000])
    text = await call_claude(http, api_key, model, prompt, max_tokens=600)
    return parse_json_response(text)


async def write_digest(
    http: httpx.AsyncClient,
    api_key: str,
    model: str,
    criteria: str,
    material_changes: list[dict[str, Any]],
) -> str:
    block_lines = []
    for c in material_changes:
        block_lines.append(
            f"- [{c['url']}] (sig {c['significance']}) {c['summary']}"
        )
    prompt = DIGEST_PROMPT.format(
        criteria=criteria,
        n=len(material_changes),
        changes_block="\n".join(block_lines),
    )
    return await call_claude(http, api_key, model, prompt, max_tokens=600)


# ---------- Webhook ----------

async def fire_webhook(http: httpx.AsyncClient, webhook_url: str, payload: dict) -> None:
    try:
        await http.post(webhook_url, json=payload, timeout=10)
        Actor.log.info(f"Webhook delivered to {webhook_url}")
    except Exception as exc:
        Actor.log.warning(f"Webhook failed: {exc}")


# ---------- Per-URL processing ----------

async def process_url(
    http: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    url: str,
    criteria: str,
    anthropic_key: str | None,
    classify_model: str,
) -> dict[str, Any] | None:
    """Returns a change record dict if a material change was detected, else None."""
    async with semaphore:
        url_hash = hashlib.sha256(url.encode()).hexdigest()[:16]
        snapshot_key = f"snapshot_{url_hash}"
        timeline_key = f"timeline_{url_hash}"
        now_iso = datetime.now(timezone.utc).isoformat()

        Actor.log.info(f"[{url_hash}] fetching {url}")
        try:
            current = await fetch_clean(http, url)
        except Exception as exc:
            Actor.log.warning(f"[{url_hash}] fetch failed: {exc}")
            return None
        if not current:
            Actor.log.warning(f"[{url_hash}] empty content")
            return None

        await Actor.charge("url-checked")

        previous = await Actor.get_value(snapshot_key)

        # First run for this URL — establish baseline silently
        if previous is None:
            await Actor.set_value(snapshot_key, {"content": current, "timestamp": now_iso})
            Actor.log.info(f"[{url_hash}] baseline established for {url}")
            return None

        if current.strip() == previous["content"].strip():
            Actor.log.info(f"[{url_hash}] no change for {url}")
            return None

        diff = compute_diff(previous["content"], current)
        if not diff.strip():
            await Actor.set_value(snapshot_key, {"content": current, "timestamp": now_iso})
            return None

        # Classify against user criteria
        if anthropic_key:
            try:
                analysis = await classify_diff(
                    http, anthropic_key, classify_model, url, criteria, diff
                )
            except Exception as exc:
                Actor.log.warning(f"[{url_hash}] classify failed, defaulting to material=true: {exc}")
                analysis = {
                    "is_material": True,
                    "significance": 3,
                    "categories": ["unclassified"],
                    "summary": "Change detected but classifier failed.",
                }
        else:
            # No API key — emit everything as material with sig=3
            analysis = {
                "is_material": True,
                "significance": 3,
                "categories": ["unclassified"],
                "summary": "Change detected (no Anthropic API key configured for classification).",
            }

        # Always update snapshot regardless of materiality, so we don't re-flag the same change
        await Actor.set_value(snapshot_key, {"content": current, "timestamp": now_iso})

        if not analysis.get("is_material"):
            Actor.log.info(f"[{url_hash}] change detected but not material per criteria; suppressed")
            return None

        await Actor.charge("material-change-detected")

        change_record = {
            "url": url,
            "detected_at": now_iso,
            "previous_at": previous["timestamp"],
            "is_material": True,
            "significance": int(analysis.get("significance", 3)),
            "categories": analysis.get("categories", []),
            "summary": analysis.get("summary", ""),
            "diff_excerpt": diff[:2000],
        }

        # Append to per-URL timeline
        timeline = await Actor.get_value(timeline_key) or []
        timeline.append({
            "ts": now_iso,
            "significance": change_record["significance"],
            "categories": change_record["categories"],
            "summary": change_record["summary"],
        })
        timeline = timeline[-TIMELINE_LIMIT:]
        await Actor.set_value(timeline_key, timeline)

        return change_record


# ---------- Entrypoint ----------

async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}

        urls = inp.get("urls") or ([inp["url"]] if inp.get("url") else [])
        criteria = (inp.get("criteria") or "").strip()
        anthropic_key = inp.get("anthropic_api_key") or os.environ.get("ANTHROPIC_API_KEY")
        webhook_url = inp.get("webhook_url")
        classify_model = inp.get("classify_model") or DEFAULT_CLASSIFY_MODEL
        digest_model = inp.get("digest_model") or DEFAULT_DIGEST_MODEL
        emit_digest = inp.get("emit_digest", True)

        if not urls:
            await Actor.fail(status_message="At least one URL required (input field 'urls')")
            return

        if not criteria:
            criteria = (
                "Anything that materially changes the user-facing meaning of the page: "
                "pricing, product/feature changes, policy or terms changes, "
                "leadership or contact changes, API or schema changes. "
                "Ignore copy polish, timestamps, ad rotation, navigation tweaks."
            )
            Actor.log.info("No criteria provided — using default materiality rules")

        await Actor.charge("run-started")
        Actor.log.info(f"Watching {len(urls)} URL(s) against criteria: {criteria[:200]}")

        material_changes: list[dict[str, Any]] = []
        semaphore = asyncio.Semaphore(CONCURRENCY)

        async with httpx.AsyncClient(follow_redirects=True) as http:
            tasks = [
                process_url(http, semaphore, url, criteria, anthropic_key, classify_model)
                for url in urls
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for r in results:
                if isinstance(r, Exception):
                    Actor.log.warning(f"URL task raised: {r}")
                    continue
                if r is not None:
                    material_changes.append(r)

            # Push per-change records to the dataset
            for record in material_changes:
                await Actor.push_data(record)

            # Build and push consolidated digest
            digest_text = None
            if emit_digest and material_changes and anthropic_key:
                try:
                    digest_text = await write_digest(
                        http, anthropic_key, digest_model, criteria, material_changes
                    )
                    await Actor.charge("digest-generated")
                    await Actor.push_data({
                        "type": "digest",
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "n_changes": len(material_changes),
                        "urls": [c["url"] for c in material_changes],
                        "digest": digest_text,
                    })
                except Exception as exc:
                    Actor.log.warning(f"Digest generation failed: {exc}")

            # Webhook gets the consolidated payload (single fire per run)
            if webhook_url and material_changes:
                payload = {
                    "run_at": datetime.now(timezone.utc).isoformat(),
                    "n_material_changes": len(material_changes),
                    "digest": digest_text,
                    "changes": material_changes,
                }
                await fire_webhook(http, webhook_url, payload)

        Actor.log.info(
            f"Run complete: {len(urls)} watched, {len(material_changes)} material changes"
        )

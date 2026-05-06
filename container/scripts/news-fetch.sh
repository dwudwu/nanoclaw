#!/bin/bash
# Pre-task news fetcher for NanoClaw scheduled tasks.
#
# Reads /workspace/agent/news-sources.json for configuration, fetches each
# source in parallel, extracts readable text, and returns structured JSON
# via stdout (last-line protocol expected by task-script.ts).
#
# Configuration file format (/workspace/agent/news-sources.json):
# {
#   "sources": [
#     { "url": "https://...", "label": "Hacker News" },
#     { "url": "https://...", "label": "BBC Tech" }
#   ],
#   "maxCharsPerSource": 8000,
#   "totalBudget": 30000
# }
#
# If no config file exists, returns wakeAgent=true with empty data so the
# agent falls back to its normal WebSearch/WebFetch flow.

exec bun /app/scripts/news-fetch-worker.ts

/**
 * Pre-task news fetcher worker.
 *
 * Fetches configured news sources in parallel, strips HTML to readable text,
 * and prints a single JSON line to stdout (task-script.ts last-line protocol).
 *
 * Runs inside the agent container via `bun /app/scripts/news-fetch-worker.ts`.
 */
import { existsSync, readFileSync } from 'fs';

const CONFIG_PATH = '/workspace/agent/news-sources.json';
const DEFAULT_MAX_CHARS_PER_SOURCE = 8000;
const DEFAULT_TOTAL_BUDGET = 30000;
const FETCH_TIMEOUT_MS = 8000;

interface Source {
  url: string;
  label?: string;
}

interface Config {
  sources: Source[];
  maxCharsPerSource: number;
  totalBudget: number;
}

interface SourceResult {
  label: string;
  url: string;
  content?: string;
  chars?: number;
  truncated?: boolean;
  error?: string;
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return {
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      maxCharsPerSource: raw.maxCharsPerSource || DEFAULT_MAX_CHARS_PER_SOURCE,
      totalBudget: raw.totalBudget || DEFAULT_TOTAL_BUDGET,
    };
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSource(source: Source, maxChars: number): Promise<SourceResult> {
  const label = source.label || source.url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NanoClaw-NewsFetcher/1.0' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { label, url: source.url, error: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const text = stripHtml(html).slice(0, maxChars);
    return { label, url: source.url, content: text, chars: text.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label, url: source.url, error: msg.slice(0, 100) };
  }
}

async function main() {
  const config = loadConfig();

  if (!config || config.sources.length === 0) {
    const note = !config
      ? 'no news-sources.json found — use normal web search'
      : 'no sources configured';
    process.stdout.write(JSON.stringify({ wakeAgent: true, data: { sources: [], note } }));
    return;
  }

  const results = await Promise.all(
    config.sources.map((s) => fetchSource(s, config.maxCharsPerSource)),
  );

  // Enforce total budget
  let totalChars = 0;
  const trimmed: SourceResult[] = [];
  for (const r of results) {
    if (r.error || !r.content) {
      trimmed.push(r);
      continue;
    }
    const remaining = config.totalBudget - totalChars;
    if (remaining <= 0) break;
    if (r.chars! > remaining) {
      r.content = r.content.slice(0, remaining);
      r.chars = remaining;
      r.truncated = true;
    }
    totalChars += r.chars!;
    trimmed.push(r);
  }

  process.stdout.write(
    JSON.stringify({
      wakeAgent: true,
      data: {
        fetchedAt: new Date().toISOString(),
        sourceCount: trimmed.length,
        totalChars,
        sources: trimmed,
      },
    }),
  );
}

main().catch((e) => {
  process.stderr.write(`[news-fetch] fatal: ${e}\n`);
  process.exit(1);
});

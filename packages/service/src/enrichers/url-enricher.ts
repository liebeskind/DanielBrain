import type pg from 'pg';
import { createHash } from 'crypto';
import { URL_ENRICHMENT_BATCH_SIZE, URL_FETCH_TIMEOUT_MS, MAX_FETCHED_CONTENT_LENGTH } from '@danielbrain/shared';
import { parsePdf } from '../parsers/pdf.js';
import { createChildLogger } from '../logger.js';
import type { UrlInventoryItem } from '../hubspot/format.js';

const log = createChildLogger('url-enricher');

// --- HTML to text conversion ---

/** Convert HTML to readable text without external dependencies */
export function htmlToText(html: string): string {
  let text = html;
  // Remove script, style, nav, footer blocks
  text = text.replace(/<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Convert <br> to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Convert block elements to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n');
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n');
  // Convert <a href="url">text</a> to text (url)
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)');
  // Strip remaining tags
  text = text.replace(/<[^>]*>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// --- URL helpers ---

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** Rewrite Google Docs edit URL to plain text export */
function rewriteGoogleDocUrl(url: string): string {
  // https://docs.google.com/document/d/DOC_ID/edit -> .../export?format=txt
  const match = url.match(/docs\.google\.com\/document\/d\/([^/]+)/);
  if (match) {
    return `https://docs.google.com/document/d/${match[1]}/export?format=txt`;
  }
  return url;
}

/** Detect auth-wall responses (login redirects, 401/403) */
function isAuthWalled(response: Response): { walled: boolean; details: string } {
  if (response.status === 401 || response.status === 403) {
    return { walled: true, details: `HTTP ${response.status}` };
  }
  const finalUrl = response.url;
  if (/accounts\.google\.com|login|signin|auth/i.test(finalUrl) && finalUrl !== response.url) {
    return { walled: true, details: `Redirected to ${finalUrl}` };
  }
  return { walled: false, details: '' };
}

// --- Core enrichment ---

interface FetchableUrl {
  thoughtId: string;
  url: string;
  urlType: string;
  anchorText?: string;
  urlIndex: number;
  sourceMeta: Record<string, unknown>;
}

/** Find thoughts with unprocessed fetchable URLs */
export async function findFetchableUrls(pool: pg.Pool, batchSize: number = URL_ENRICHMENT_BATCH_SIZE): Promise<FetchableUrl[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.source_meta
     FROM thoughts t
     WHERE t.source = 'hubspot'
       AND t.source_meta->>'object_type' = 'note'
       AND t.source_meta->'extracted_urls' IS NOT NULL
       AND jsonb_array_length(t.source_meta->'extracted_urls') > 0
       AND t.parent_id IS NULL
     ORDER BY t.created_at DESC
     LIMIT 50`,
  );

  const candidates: FetchableUrl[] = [];
  for (const row of rows) {
    const urls = (row.source_meta?.extracted_urls as UrlInventoryItem[]) || [];
    for (let i = 0; i < urls.length; i++) {
      if (urls[i].fetchable && !urls[i].processed) {
        candidates.push({
          thoughtId: row.id,
          url: urls[i].url,
          urlType: urls[i].type,
          anchorText: urls[i].anchor_text,
          urlIndex: i,
          sourceMeta: row.source_meta,
        });
        if (candidates.length >= batchSize) return candidates;
      }
    }
  }
  return candidates;
}

/** Fetch URL content and convert to text */
export async function fetchAndConvert(url: string, urlType: string): Promise<{ text: string; contentType: string }> {
  const fetchUrl = urlType === 'google_doc' ? rewriteGoogleDocUrl(url) : url;

  const response = await fetch(fetchUrl, {
    headers: {
      'User-Agent': 'DanielBrain/1.0 (knowledge-enricher)',
      'Accept': 'text/html, text/plain, application/pdf',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
  });

  // Check for auth walls
  const auth = isAuthWalled(response);
  if (auth.walled) {
    throw new AuthRequiredError(auth.details);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // PDF handling
  if (contentType.includes('application/pdf') || urlType === 'pdf') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_FETCHED_CONTENT_LENGTH) {
      throw new ContentTooLargeError(buffer.length);
    }
    const result = await parsePdf(buffer);
    return { text: result.text, contentType: 'application/pdf' };
  }

  // Text/HTML handling
  if (!contentType.includes('text/') && !contentType.includes('application/json')) {
    throw new UnsupportedTypeError(contentType);
  }

  const text = await response.text();
  if (text.length > MAX_FETCHED_CONTENT_LENGTH) {
    throw new ContentTooLargeError(text.length);
  }

  if (contentType.includes('text/html')) {
    return { text: htmlToText(text), contentType: 'text/html' };
  }

  return { text, contentType };
}

/** Enqueue fetched content as a new thought */
async function enqueueUrlContent(
  pool: pg.Pool,
  parentThoughtId: string,
  url: string,
  content: string,
  parentSourceMeta: Record<string, unknown>,
): Promise<boolean> {
  const sourceId = `hubspot-url-${hashUrl(url)}`;
  const hubspotAssociations = parentSourceMeta.hubspotAssociations || {};

  const { rowCount } = await pool.query(
    `INSERT INTO queue (content, source, source_id, source_meta, originated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [
      content,
      'hubspot-url',
      sourceId,
      JSON.stringify({
        parent_thought_id: parentThoughtId,
        fetched_url: url,
        channel_type: 'web',
        hubspotAssociations,
      }),
    ],
  );

  return (rowCount ?? 0) > 0;
}

/** Mark a URL as processed in the parent thought's source_meta */
export async function markUrlProcessed(
  pool: pg.Pool,
  thoughtId: string,
  urlIndex: number,
  status: string,
  details?: string,
): Promise<void> {
  // Update the specific URL entry in the extracted_urls array
  const setProcessed = details
    ? `jsonb_set(jsonb_set(source_meta, ARRAY['extracted_urls', $2::text, 'processed'], to_jsonb($3::text)), ARRAY['extracted_urls', $2::text, 'details'], to_jsonb($4::text))`
    : `jsonb_set(source_meta, ARRAY['extracted_urls', $2::text, 'processed'], to_jsonb($3::text))`;

  await pool.query(
    `UPDATE thoughts SET source_meta = ${setProcessed}, updated_at = NOW() WHERE id = $1`,
    details ? [thoughtId, String(urlIndex), status, details] : [thoughtId, String(urlIndex), status],
  );
}

// --- Custom errors for status classification ---

export class AuthRequiredError extends Error {
  constructor(public details: string) { super(`Auth required: ${details}`); }
}

export class ContentTooLargeError extends Error {
  constructor(public size: number) { super(`Content too large: ${size} bytes`); }
}

export class UnsupportedTypeError extends Error {
  constructor(public contentType: string) { super(`Unsupported content type: ${contentType}`); }
}

// --- Batch enrichment ---

/** Process a batch of fetchable URLs */
export async function enrichUrlBatch(pool: pg.Pool): Promise<number> {
  const candidates = await findFetchableUrls(pool);
  if (candidates.length === 0) return 0;

  let processed = 0;

  for (const candidate of candidates) {
    try {
      const { text } = await fetchAndConvert(candidate.url, candidate.urlType);

      if (!text || text.trim().length < 50) {
        await markUrlProcessed(pool, candidate.thoughtId, candidate.urlIndex, 'error', 'Content too short or empty');
        processed++;
        continue;
      }

      const enqueued = await enqueueUrlContent(pool, candidate.thoughtId, candidate.url, text, candidate.sourceMeta);
      await markUrlProcessed(
        pool, candidate.thoughtId, candidate.urlIndex,
        enqueued ? 'success' : 'success', // even if dedup'd, mark as processed
      );

      if (enqueued) {
        log.info({ url: candidate.url, type: candidate.urlType, thoughtId: candidate.thoughtId }, 'URL content enqueued');
      }
      processed++;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        await markUrlProcessed(pool, candidate.thoughtId, candidate.urlIndex, 'auth_required', err.details);
        log.info({ url: candidate.url, type: candidate.urlType, details: err.details }, 'URL requires authentication');
      } else if (err instanceof ContentTooLargeError) {
        await markUrlProcessed(pool, candidate.thoughtId, candidate.urlIndex, 'too_large', `${err.size} bytes`);
      } else if (err instanceof UnsupportedTypeError) {
        await markUrlProcessed(pool, candidate.thoughtId, candidate.urlIndex, 'unsupported_type', err.contentType);
      } else {
        await markUrlProcessed(pool, candidate.thoughtId, candidate.urlIndex, 'error', (err as Error).message);
        log.error({ err, url: candidate.url }, 'URL fetch failed');
      }
      processed++;
    }
  }

  return processed;
}

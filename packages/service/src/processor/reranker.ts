import { createChildLogger } from '../logger.js';

const log = createChildLogger('reranker');

let tokenizer: any = null;
let model: any = null;
let loadPromise: Promise<boolean> | null = null;
let currentModelId: string | null = null;

/** Lazy-load the cross-encoder model. Returns true if ready. */
async function ensureModel(modelId: string): Promise<boolean> {
  if (model && currentModelId === modelId) return true;
  if (loadPromise && currentModelId === modelId) return loadPromise;

  currentModelId = modelId;
  loadPromise = (async () => {
    try {
      const start = Date.now();
      log.info({ model: modelId }, 'Loading cross-encoder reranker');
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
      tokenizer = await AutoTokenizer.from_pretrained(modelId);
      model = await AutoModelForSequenceClassification.from_pretrained(modelId);
      log.info({ model: modelId, loadTimeMs: Date.now() - start }, 'Reranker model loaded');
      return true;
    } catch (err) {
      log.error({ err, model: modelId }, 'Failed to load reranker model');
      model = null;
      tokenizer = null;
      return false;
    }
  })();

  return loadPromise;
}

/**
 * Rerank items by relevance to a query using a cross-encoder model.
 * Falls back to original order if model is unavailable.
 *
 * @param query - the search query
 * @param items - items to rerank
 * @param getContent - extract document text from an item (summary preferred, fallback to content)
 * @param rerankerModel - HuggingFace model ID (e.g. 'Xenova/ms-marco-MiniLM-L-6-v2')
 * @param topK - optional limit on returned items
 */
export async function rerank<T>(
  query: string,
  items: T[],
  getContent: (item: T) => string,
  rerankerModel: string,
  topK?: number,
): Promise<T[]> {
  if (items.length <= 1) return items;

  const ready = await ensureModel(rerankerModel);
  if (!ready) return items;

  try {
    const start = Date.now();
    const documents = items.map(getContent);
    const queries = items.map(() => query);

    const inputs = tokenizer(queries, {
      text_pair: documents,
      padding: true,
      truncation: true,
      max_length: 512,
    });

    const output = await model(inputs);
    // Cross-encoder outputs logits: higher = more relevant
    // Shape is [n, 1] for single-label classification; .data is a Float32Array
    const logits: Float32Array = output.logits.data;

    const scored = items.map((item, i) => ({
      item,
      score: logits[i],
    }));

    scored.sort((a, b) => b.score - a.score);

    const limit = topK ?? items.length;
    const result = scored.slice(0, limit).map((s) => s.item);

    log.debug(
      { query: query.slice(0, 80), count: items.length, topK: limit, rerankMs: Date.now() - start },
      'Reranked results',
    );
    return result;
  } catch (err) {
    log.warn({ err }, 'Reranking failed, using original order');
    return items;
  }
}

/** Reset model state (for testing) */
export function resetReranker(): void {
  tokenizer = null;
  model = null;
  loadPromise = null;
  currentModelId = null;
}

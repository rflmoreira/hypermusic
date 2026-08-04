// Netlify Function - Proxy dedicado para a API do Deezer (busca de capas)
// Elimina a dependência de proxies públicos de CORS (corsproxy.io, codetabs...)
// que vinham sendo bloqueados. Inclui cache em memória (por instância) e
// headers de cache para o CDN reduzir invocações repetidas.

import { CORS_HEADERS, makeResponse } from './utils.js';

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_CACHE_ENTRIES = 500;

// Cache em memória: persiste enquanto a instância da function estiver "quente"
const memoryCache = new Map();

const ENDPOINTS = {
  track: 'https://api.deezer.com/search',
  playlist: 'https://api.deezer.com/search/playlist',
  album: 'https://api.deezer.com/search/album',
  artist: 'https://api.deezer.com/search/artist'
};

function getCached(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  // Poda entradas mais antigas quando atinge o limite
  if (memoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, { value, timestamp: Date.now() });
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return makeResponse(405, { error: 'Method not allowed' });
  }

  const { q, type = 'track' } = event.queryStringParameters || {};
  const query = (q || '').trim();

  if (!query) {
    return makeResponse(400, { error: 'Missing q parameter', reason: 'missing-query' });
  }

  const endpoint = ENDPOINTS[type] || ENDPOINTS.track;
  const cacheKey = `${type}:${query.toLowerCase()}`;

  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[DEEZER] cache HIT ${type}:"${query}"`);
    return makeResponse(200, cached, { 'X-Cache': 'HIT' });
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&limit=15`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });

    const elapsed = Date.now() - startedAt;

    if (!response.ok) {
      console.error(`[DEEZER] upstream HTTP ${response.status} for ${type}:"${query}" (${elapsed}ms)`);
      return makeResponse(502, { error: `Deezer upstream error (${response.status})`, reason: 'upstream-error' });
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      console.error(`[DEEZER] invalid JSON for ${type}:"${query}" (${elapsed}ms)`);
      return makeResponse(502, { error: 'Invalid JSON from Deezer', reason: 'invalid-json' });
    }

    // A API do Deezer pode retornar erro dentro do body com HTTP 200 (ex: quota)
    if (data.error) {
      console.error(`[DEEZER] API error for ${type}:"${query}": ${JSON.stringify(data.error)} (${elapsed}ms)`);
      const isQuota = data.error?.code === 4; // quota limit exceeded
      return makeResponse(isQuota ? 429 : 502, { error: 'Deezer API error', reason: isQuota ? 'quota' : 'api-error', detail: data.error }, isQuota ? { 'Retry-After': '5' } : {});
    }

    setCached(cacheKey, data);
    console.log(`[DEEZER] cache MISS ${type}:"${query}" -> ${data?.data?.length ?? 0} results (${elapsed}ms)`);
    return makeResponse(200, data, { 'X-Cache': 'MISS' });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (error.name === 'AbortError') {
      console.error(`[DEEZER] timeout for ${type}:"${query}" (${elapsed}ms)`);
      return makeResponse(504, { error: 'Deezer timeout', reason: 'timeout' });
    }
    console.error(`[DEEZER] network error for ${type}:"${query}": ${error.message} (${elapsed}ms)`);
    return makeResponse(502, { error: 'Deezer fetch failed', reason: 'network-error', detail: error.message });
  } finally {
    clearTimeout(timer);
  }
};

// Netlify Function - Extrai áudio do YouTube via youtube-mp36 (RapidAPI)
// A API youtube-mp36 é um serviço de CONVERSÃO: a primeira chamada para um vídeo
// pode retornar status "processing" (conversão em andamento). Este handler faz
// polling dentro do orçamento de tempo da function e classifica cada falha com
// um motivo estruturado para o frontend decidir entre retry e fallback.

import { CORS_HEADERS, makeResponse } from './utils.js';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// Netlify functions síncronas têm limite de ~10s; mantém margem de segurança.
const TOTAL_BUDGET_MS = 6500;
const FETCH_TIMEOUT_MS = 3500;
const POLL_DELAY_MS = 1400;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Classifica a mensagem de erro do youtube-mp36 em um motivo estruturado.
// IMPORTANTE: só classifica como permanente com evidência explícita — mensagens
// genéricas/transitórias do conversor NÃO podem virar 404 permanente, senão
// vídeos válidos ficam blacklistados no frontend por falha momentânea.
function classifyFailure(msg = '') {
  const m = String(msg).toLowerCase();
  // "invalid" sozinho é ambíguo (ex: JSON inválido do upstream); exige contexto de vídeo/id
  if (m.includes('unavailable') || m.includes('not exist') || m.includes('not found') || /invalid\s*(video|id|url|link|param)/.test(m)) return 'video-not-found';
  if (m.includes('private')) return 'video-private';
  if (m.includes('country') || m.includes('region') || m.includes('geo')) return 'geo-blocked';
  if (m.includes('copyright') || m.includes('blocked')) return 'video-blocked';
  if (m.includes('too long') || m.includes('duration')) return 'video-too-long';
  return 'extraction-failed';
}

// Motivos que não adianta re-tentar (o vídeo nunca vai converter)
const PERMANENT_REASONS = new Set(['video-not-found', 'video-private', 'geo-blocked', 'video-blocked', 'video-too-long']);

/**
 * Uma tentativa de conversão. Retorna um objeto discriminado por `kind`:
 * ok | processing | fail | http-error | timeout | network-error
 */
async function fetchConversion(videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      // JSON inválido é problema do upstream (transitório), nunca do vídeo
      return { kind: 'network-error', msg: 'invalid-json-from-upstream' };
    }

    if (data.status === 'ok' && data.link) {
      return {
        kind: 'ok',
        audioUrl: data.link,
        title: data.title || '',
        duration: data.duration || 0
      };
    }

    if (data.status === 'processing' || /process/i.test(data.msg || '')) {
      return { kind: 'processing', msg: data.msg || 'in process' };
    }

    return { kind: 'fail', msg: data.msg || `status=${data.status}` };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { kind: 'timeout' };
    }
    return { kind: 'network-error', msg: error.message };
  } finally {
    clearTimeout(timer);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return makeResponse(405, { error: 'Method not allowed' });
  }

  const { v: videoId } = event.queryStringParameters || {};

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    console.warn(`[AUDIO] Rejected invalid videoId: "${videoId}"`);
    return makeResponse(400, { error: 'Invalid or missing video ID', reason: 'invalid-video-id', retryable: false });
  }

  if (!RAPIDAPI_KEY) {
    console.error('[AUDIO] RAPIDAPI_KEY not configured');
    return makeResponse(503, { error: 'Audio service not configured', reason: 'not-configured', retryable: false });
  }

  const startedAt = Date.now();
  let attempt = 0;
  let last = null;

  while (true) {
    attempt += 1;
    last = await fetchConversion(videoId);
    const elapsed = Date.now() - startedAt;

    if (last.kind === 'ok') {
      console.log(`[AUDIO] ${videoId} OK in ${elapsed}ms (attempt ${attempt})`);
      return makeResponse(200, {
        videoId,
        audioUrl: last.audioUrl,
        title: last.title,
        duration: last.duration
      });
    }

    if (last.kind === 'http-error') {
      // Propaga rate limit para o frontend fazer backoff (ele já trata 429)
      if (last.status === 429) {
        console.warn(`[AUDIO] ${videoId} upstream rate-limited (attempt ${attempt}, ${elapsed}ms)`);
        return makeResponse(429, { error: 'Upstream rate limit', reason: 'rate-limited', retryable: true }, { 'Retry-After': '2' });
      }
      if (last.status === 401 || last.status === 403) {
        console.error(`[AUDIO] ${videoId} upstream auth/quota error HTTP ${last.status} (${elapsed}ms)`);
        return makeResponse(503, { error: `Upstream auth/quota error (${last.status})`, reason: 'quota-or-auth', retryable: false });
      }
      console.error(`[AUDIO] ${videoId} upstream HTTP ${last.status} (attempt ${attempt}, ${elapsed}ms)`);
      // 5xx do upstream pode ser transitório: re-tenta dentro do orçamento
    }

    if (last.kind === 'fail') {
      const reason = classifyFailure(last.msg);
      if (PERMANENT_REASONS.has(reason)) {
        console.warn(`[AUDIO] ${videoId} permanent failure: ${reason} ("${last.msg}") in ${elapsed}ms`);
        return makeResponse(404, { error: 'Could not extract audio', reason, detail: last.msg, retryable: false });
      }
      console.warn(`[AUDIO] ${videoId} transient failure: ${reason} ("${last.msg}") attempt ${attempt} (${elapsed}ms)`);
      // extraction-failed transitório: re-tenta dentro do orçamento
    }

    if (last.kind === 'processing') {
      console.log(`[AUDIO] ${videoId} still processing (attempt ${attempt}, ${elapsed}ms)`);
    }

    if (last.kind === 'timeout' || last.kind === 'network-error') {
      console.warn(`[AUDIO] ${videoId} ${last.kind}${last.msg ? ` (${last.msg})` : ''} attempt ${attempt} (${elapsed}ms)`);
    }

    // Verifica orçamento antes de nova tentativa
    if (Date.now() - startedAt + POLL_DELAY_MS + FETCH_TIMEOUT_MS > TOTAL_BUDGET_MS) {
      break;
    }
    await delay(POLL_DELAY_MS);
  }

  const totalElapsed = Date.now() - startedAt;

  // Conversão ainda em andamento: 202 sinaliza ao frontend para re-tentar em breve
  if (last?.kind === 'processing') {
    console.log(`[AUDIO] ${videoId} conversion still in progress after ${attempt} attempts (${totalElapsed}ms) -> 202`);
    return makeResponse(202, { error: 'Conversion in progress', reason: 'processing', retryable: true }, { 'Retry-After': '3' });
  }

  if (last?.kind === 'timeout') {
    console.warn(`[AUDIO] ${videoId} gave up after timeout (${attempt} attempts, ${totalElapsed}ms)`);
    return makeResponse(504, { error: 'Upstream timeout', reason: 'timeout', retryable: true });
  }

  if (last?.kind === 'http-error') {
    console.error(`[AUDIO] ${videoId} gave up after upstream HTTP ${last.status} (${attempt} attempts, ${totalElapsed}ms)`);
    return makeResponse(502, { error: `Upstream error (${last.status})`, reason: 'upstream-error', retryable: true });
  }

  if (last?.kind === 'network-error') {
    console.warn(`[AUDIO] ${videoId} gave up after network error (${attempt} attempts, ${totalElapsed}ms)`);
    return makeResponse(502, { error: 'Upstream network error', reason: 'upstream-error', retryable: true });
  }

  // Falha do conversor sem motivo permanente após esgotar o orçamento:
  // transitória na maioria dos casos (extração falha e funciona minutos depois).
  // Retorna 502 retryable — NUNCA 404 permanente para não blacklistar vídeo válido.
  const reason = last?.kind === 'fail' ? classifyFailure(last.msg) : 'internal-error';
  if (reason === 'extraction-failed' || reason === 'internal-error') {
    console.warn(`[AUDIO] ${videoId} transient extraction failure after ${attempt} attempts (${totalElapsed}ms) -> 502 retryable`);
    return makeResponse(502, { error: 'Could not extract audio (transient)', reason: 'extraction-failed', detail: last?.msg || null, retryable: true });
  }

  console.error(`[AUDIO] ${videoId} failed: ${reason} after ${attempt} attempts (${totalElapsed}ms)`);
  return makeResponse(404, { error: 'Could not extract audio', reason, detail: last?.msg || null, retryable: false });
};

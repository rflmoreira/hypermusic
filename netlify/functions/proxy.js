// Serverless proxy para liberar CORS (Access-Control-Allow-Origin: *)
// Suporta GET/HEAD/POST com streaming de áudio

import { CORS_HEADERS, makeResponse } from './utils.js';

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST'];
const PASSTHROUGH_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'etag',
  'last-modified'
];

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return makeResponse({ statusCode: 200 });
  }

  if (!ALLOWED_METHODS.includes(event.httpMethod)) {
    return makeResponse({ statusCode: 405, body: 'Method Not Allowed' });
  }

  const target = event.queryStringParameters?.url;
  if (!target || typeof target !== 'string') {
    return makeResponse({ statusCode: 400, body: 'Missing url param' });
  }

  let url;
  try {
    url = new URL(target);
  } catch (err) {
    return makeResponse({ statusCode: 400, body: 'Invalid url param' });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return makeResponse({ statusCode: 400, body: 'Unsupported protocol' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const headers = {
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    };

    const incomingRange = event.headers?.range || event.headers?.Range;
    if (incomingRange) {
      headers['Range'] = incomingRange;
    }

    const incomingContentType = event.headers?.['content-type'] || event.headers?.['Content-Type'];
    if (incomingContentType) {
      headers['Content-Type'] = incomingContentType;
    }

    const body = event.httpMethod === 'POST'
      ? (event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body)
      : undefined;

    const res = await fetch(url.toString(), {
      method: event.httpMethod,
      headers,
      redirect: 'follow',
      body,
      signal: controller.signal
    });

    clearTimeout(timeout);

    // Se o servidor retornou erro, propaga
    if (!res.ok && res.status !== 206) {
      return makeResponse({
        statusCode: res.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Upstream error: ${res.status}` })
      });
    }

    const responseHeaders = {};
    PASSTHROUGH_RESPONSE_HEADERS.forEach((name) => {
      const value = res.headers.get(name);
      if (value) {
        const key = name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
        responseHeaders[key] = value;
      }
    });

    const contentType = responseHeaders['Content-Type'] || res.headers.get('content-type') || 'application/octet-stream';
    responseHeaders['Content-Type'] = contentType;

    if (event.httpMethod === 'HEAD') {
      return makeResponse({ statusCode: res.status, headers: responseHeaders });
    }

    // JSON/text direto
    if (contentType.includes('application/json') || contentType.startsWith('text/')) {
      const text = await res.text();
      return makeResponse({ statusCode: res.status, headers: responseHeaders, body: text });
    }

    // Binário (áudio/vídeo) - retorna como base64
    const arrayBuffer = await res.arrayBuffer();
    return makeResponse({
      statusCode: res.status,
      headers: responseHeaders,
      body: Buffer.from(arrayBuffer).toString('base64'),
      isBase64Encoded: true
    });
  } catch (error) {
    console.error('Proxy Error:', error);
    return makeResponse({
      statusCode: 502,
      body: JSON.stringify({ error: `Proxy error: ${error?.message || 'fetch failed'}` })
    });
  }
};

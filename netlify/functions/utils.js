export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS,POST,HEAD',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

export function makeResponse(arg1, arg2, arg3) {
  // Proxy.js object signature
  if (typeof arg1 === 'object' && arg1 !== null && arg1.statusCode) {
    const { statusCode, headers = {}, body = '', isBase64Encoded = false } = arg1;
    return {
      statusCode,
      headers: { ...CORS_HEADERS, ...headers },
      body,
      isBase64Encoded
    };
  }

  // Standard signature: makeResponse(statusCode, body, extraHeaders)
  const statusCode = arg1;
  const body = arg2;
  const extraHeaders = arg3 || {};

  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dispatcher } from 'undici';
import { contentLengthInterceptor, normalizeContentLength } from './long-fetch.js';

test('normalizeContentLength keeps one number, collapses a repeat, drops the rest', () => {
  assert.equal(normalizeContentLength('133'), '133');
  assert.equal(normalizeContentLength('133, 133'), '133');
  assert.equal(normalizeContentLength(['133', '133']), '133');
  assert.equal(normalizeContentLength('133, 134'), undefined);
  assert.equal(normalizeContentLength('abc'), undefined);
  assert.equal(normalizeContentLength(''), undefined);
});

function seen(headers: Dispatcher.DispatchOptions['headers']): Dispatcher.DispatchOptions['headers'] {
  let captured: Dispatcher.DispatchOptions['headers'];
  const dispatch = contentLengthInterceptor((opts) => {
    captured = opts.headers;
    return true;
  });
  dispatch({ method: 'POST', path: '/', origin: 'https://x', headers }, {} as Dispatcher.DispatchHandler);
  return captured;
}

test('interceptor rewrites the object shape Node fetch hands to undici', () => {
  assert.deepEqual(seen({ 'content-type': 'application/json', 'Content-Length': '133, 133' }), { 'content-type': 'application/json', 'Content-Length': '133' });
  assert.deepEqual(seen({ 'content-length': '10, 20', accept: '*/*' }), { accept: '*/*' });
  assert.deepEqual(seen({ 'content-length': '42' }), { 'content-length': '42' });
});

test('interceptor rewrites the flat array shape', () => {
  assert.deepEqual(seen(['content-length', '133, 133', 'accept', '*/*']), ['content-length', '133', 'accept', '*/*']);
  assert.deepEqual(seen(['accept', '*/*', 'content-length', '1, 2']), ['accept', '*/*']);
});

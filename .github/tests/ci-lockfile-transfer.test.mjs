import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeLockfile, decodeLockfile, encodeLockfileOutputs, decodeLockfileOutputs, MAX_FRAME_BYTES, MAX_LOCKFILE_BYTES } from '../scripts/ci-lockfile-transfer.mjs';
const revision = '390a5d87c771b4feea8f82e3333c5981e78bd3ac';
test('preserves exact Unicode/CRLF bytes and revision binding', () => {
  const bytes = Buffer.from('lockfileVersion: 9\r\n# שלום\r\n');
  const frame = encodeLockfile(bytes, revision);
  assert.deepEqual(decodeLockfile(frame, revision), bytes);
  assert.equal(encodeLockfile(bytes, revision), frame);
  assert.throws(() => decodeLockfile(frame, '0'.repeat(40)));
  assert.throws(() => encodeLockfile(bytes, 'invalid'));
});
test('rejects malformed, oversized and unauthenticated frames', () => {
  const frame = encodeLockfile(Buffer.from('lockfile'), revision);
  const data = JSON.parse(frame);
  for (const value of ['', 'null', '[]', frame + '\n', 'x'.repeat(MAX_FRAME_BYTES + 1), JSON.stringify({ ...data, version: 2 }), JSON.stringify({ ...data, extra: 1 }), JSON.stringify({ ...data, sha256: '0'.repeat(64) }), JSON.stringify({ ...data, payload: data.payload + '=' }), JSON.stringify({ ...data, payload: data.payload.slice(4) })]) assert.throws(() => decodeLockfile(value, revision));
  assert.throws(() => encodeLockfile(Buffer.alloc(0), revision));
  assert.throws(() => encodeLockfile(Buffer.alloc(MAX_LOCKFILE_BYTES + 1), revision));
  const bomb = JSON.stringify({ ...data, payload: gzipSync(Buffer.alloc(MAX_LOCKFILE_BYTES + 1)).toString('base64') });
  assert.throws(() => decodeLockfile(bomb, revision));
});
test('large lockfile transport stays below Linux per-environment-string limit', () => {
  const bytes = randomBytes(180000);
  const { count, parts } = encodeLockfileOutputs(bytes, revision);
  assert(Number(count) > 1);
  assert.equal(parts.length, 8);
  for (const [i, part] of parts.entries()) assert(Buffer.byteLength('LOCKFILE_PART_' + i + '=' + part) + 1 < 128 * 1024);
  assert.deepEqual(decodeLockfileOutputs(count, parts, revision), bytes);
  const bad = [
    [count, parts.map((p, i) => i === 1 ? '' : p)],
    [count, [parts[1], parts[0], ...parts.slice(2)]],
    [count, parts.map((p, i) => i === 7 ? 'x' : p)],
    [count, parts.map((p, i) => i === 0 ? p.slice(1) : p)],
    [count, parts.map((p, i) => i === 0 ? p + 'x' : p)],
    ['0', parts], ['05', parts], [count, parts.slice(1)],
  ];
  for (const [n, value] of bad) assert.throws(() => decodeLockfileOutputs(n, value, revision));
});

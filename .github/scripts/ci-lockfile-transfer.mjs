import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// GitHub job outputs have a one-MiB UTF-16 budget. Leave room for metadata.
export const MAX_FRAME_BYTES = 384 * 1024;
export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireHead(head) {
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid lockfile source revision');
}
export function encodeLockfile(bytes, head) {
  requireHead(head);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_LOCKFILE_BYTES) throw new Error('Invalid lockfile size');
  const frame = JSON.stringify({ version: 1, head, sha256: sha256(bytes), payload: gzipSync(bytes).toString('base64') });
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('Lockfile exceeds bounded job-output transfer');
  return frame;
}
export function decodeLockfile(frame, expectedHead) {
  requireHead(expectedHead);
  if (typeof frame !== 'string' || frame.length === 0 || Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES || /[\r\n]/.test(frame)) throw new Error('Invalid lockfile transfer frame');
  const data = JSON.parse(frame);
  if (!data || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'head,payload,sha256,version' || data.version !== 1 || data.head !== expectedHead || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256) || typeof data.payload !== 'string') throw new Error('Invalid lockfile identity');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.payload) || data.payload.length % 4 !== 0 || Buffer.from(data.payload, 'base64').toString('base64') !== data.payload) throw new Error('Invalid lockfile encoding');
  const bytes = gunzipSync(Buffer.from(data.payload, 'base64'), { maxOutputLength: MAX_LOCKFILE_BYTES });
  if (bytes.length === 0 || sha256(bytes) !== data.sha256) throw new Error('Lockfile digest mismatch');
  return bytes;
}

// Linux bounds each individual environment string to about 128 KiB.
// Keep each output/environment part below 48 KiB, including its name.
export const LOCKFILE_PART_BYTES = 48 * 1024;
export const LOCKFILE_MAX_PARTS = 8;
export function encodeLockfileOutputs(bytes, head) {
  const frame = encodeLockfile(bytes, head);
  const parts = frame.match(/.{1,49152}/g);
  if (!parts || parts.length > LOCKFILE_MAX_PARTS) throw new Error('Invalid lockfile part count');
  return { count: String(parts.length), parts: Array.from({ length: LOCKFILE_MAX_PARTS }, (_, i) => parts[i] ?? '') };
}
export function decodeLockfileOutputs(count, parts, expectedHead) {
  if (typeof count !== 'string' || !/^[1-8]$/.test(count) || !Array.isArray(parts) || parts.length !== LOCKFILE_MAX_PARTS) throw new Error('Invalid lockfile part count');
  const length = Number(count);
  for (let i = 0; i < parts.length; i++) {
    if (typeof parts[i] !== 'string' || parts[i].length > LOCKFILE_PART_BYTES || (i >= length ? parts[i] !== '' : parts[i].length === 0 || (i < length - 1 && parts[i].length !== LOCKFILE_PART_BYTES))) throw new Error('Invalid lockfile part shape');
  }
  return decodeLockfile(parts.slice(0, length).join(''), expectedHead);
}

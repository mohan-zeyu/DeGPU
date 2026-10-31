// Ethereum Keccak-256 (domain 0x01), not standardized SHA3-256. Only the
// inexpensive checker runs here; fixture answers are not an in-browser solver.
const MASK = (1n << 64n) - 1n;
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RC = [1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const rotate = (x, n) => n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK : x;
export const bytesHex = (bytes) => `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
export function hexBytes(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(hex)) throw new Error('字节须为 0x 十六进制字符串');
  return Uint8Array.from(hex.slice(2).match(/../g) || [], (byte) => parseInt(byte, 16));
}
export function word(value) {
  const number = BigInt(value);
  if (number < 0n || number >= 1n << 256n) throw new Error('整数超出 uint256');
  return `0x${number.toString(16).padStart(64, '0')}`;
}
export function keccak256(input) {
  const bytes = typeof input === 'string' ? hexBytes(input) : Uint8Array.from(input);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / 136) * 136);
  padded.set(bytes); padded[bytes.length] = 1; padded[padded.length - 1] |= 0x80;
  let a = Array(25).fill(0n);
  for (let start = 0; start < padded.length; start += 136) {
    for (let i = 0; i < 136; i += 1) a[Math.floor(i / 8)] ^= BigInt(padded[start + i]) << BigInt((i % 8) * 8);
    for (const constant of RC) {
      const c = Array.from({ length: 5 }, (_, x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
      const d = c.map((_, x) => c[(x + 4) % 5] ^ rotate(c[(x + 1) % 5], 1));
      a = a.map((lane, i) => lane ^ d[i % 5]);
      const b = Array(25).fill(0n);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(a[x + 5 * y], ROT[x + 5 * y]);
      a = b.map((lane, i) => lane ^ ((~b[(i % 5 + 1) % 5 + 5 * Math.floor(i / 5)]) & b[(i % 5 + 2) % 5 + 5 * Math.floor(i / 5)]));
      a[0] ^= constant;
    }
  }
  return bytesHex(Array.from({ length: 32 }, (_, i) => Number((a[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 255n)));
}

export const CHECKED_TASKS = Object.freeze([
  Object.freeze({ id: 'key-search-v1', chainId: 1, mode: 'checked', name: '密钥搜索', registered: true, maxItems: 1000, defaultItems: 8, secondsPerItem: 2 }),
]);
const challenge = `0x${'11'.repeat(32)}`;
const join = (...parts) => `0x${parts.map((part) => part.slice(2)).join('')}`;
export const NONCE_FIXTURES = Object.freeze([
  Object.freeze({ id: 'nonce-1', item: join(challenge, word(1n << 248n)), answer: word(218), value: '218' }),
  Object.freeze({ id: 'nonce-2', item: join(challenge, word((1n << 256n) - 1n)), answer: word(7), value: '7' }),
  Object.freeze({ id: 'nonce-impossible', item: join(challenge, word(0)), answer: null, value: null }),
]);
export const KEY_FIXTURES = Object.freeze([...([42, 137, 256, 384, 512, 679, 803, 965].map((key, index) => Object.freeze({
  id: `key-${index + 1}`, item: join(keccak256(word(key)), word(0), word(1000)), answer: word(key), value: String(key),
}))), Object.freeze({ id: 'key-large', item: join(keccak256(word((1n << 128n) + 42n)), word(1n << 128n), word((1n << 128n) + 65536n)), answer: word((1n << 128n) + 42n), value: ((1n << 128n) + 42n).toString() }),
Object.freeze({ id: 'key-impossible', item: join(keccak256(word(42)), word(43), word(44)), answer: null, value: null })]);
export function checkedFixtures(taskType, itemCount = 8, fixtureIds) {
  const fixtures = taskType === 'key-search-v1' ? KEY_FIXTURES : taskType === 'nonce-search-v1' ? NONCE_FIXTURES : null;
  if (!fixtures) throw new Error('未知 checked 任务');
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 1000) throw new Error('任务数量须为 1–1000 的整数');
  if (fixtureIds !== undefined && (!Array.isArray(fixtureIds) || fixtureIds.length !== itemCount)) throw new Error('内置输入列表须与任务数量一致');
  const available = fixtures.filter((fixture) => fixture.answer !== null);
  return Array.from({ length: itemCount }, (_, index) => {
    const fixture = fixtureIds === undefined ? available[index % available.length] : fixtures.find((entry) => entry.id === fixtureIds[index]);
    if (!fixture) throw new Error('未知内置输入');
    return fixture;
  });
}
export function checkCheckedAnswer(taskType, item, answer) {
  try {
    const input = hexBytes(item);
    if (hexBytes(answer).length !== 32) return false;
    // Solidity abi.decode reads the fixed tuple and tolerates trailing bytes.
    if (taskType === 'nonce-search-v1' && input.length >= 64) {
      return BigInt(keccak256(join(bytesHex(input.slice(0, 32)), answer))) < BigInt(bytesHex(input.slice(32, 64)));
    }
    if (taskType === 'key-search-v1' && input.length >= 96) {
      const key = BigInt(answer);
      return key >= BigInt(bytesHex(input.slice(32, 64))) && key < BigInt(bytesHex(input.slice(64, 96)))
        && keccak256(answer) === bytesHex(input.slice(0, 32));
    }
    return false;
  } catch { return false; }
}
export function checkedItemsHash(items) {
  const entries = items.map((item) => hexBytes(item));
  let offset = 32 * entries.length;
  const tails = entries.map((bytes) => {
    const data = bytesHex(bytes).slice(2).padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    const entry = `${word(bytes.length).slice(2)}${data}`;
    const head = word(offset).slice(2);
    offset += entry.length / 2;
    return { head, entry };
  });
  return keccak256(`0x${word(32).slice(2)}${word(entries.length).slice(2)}${tails.map((tail) => tail.head).join('')}${tails.map((tail) => tail.entry).join('')}`);
}
export function checkedSubmission(job, variant = job.scenario) {
  const fixtures = [...KEY_FIXTURES, ...NONCE_FIXTURES];
  const answers = job.items.map((item) => fixtures.find((fixture) => fixture.item === item)?.answer || word(0));
  const found = job.items.map((item, index) => Boolean(fixtures.find((fixture) => fixture.item === item)?.answer)
    && variant !== 'checked-none' && (variant !== 'checked-partial' || index % 2 === 0));
  if (variant === 'checked-invalid') {
    // A high nonce target can accept zero too. Never present a checker-valid
    // answer as a rejection merely because the fixture requests that outcome.
    const candidates = [word(0), word(1), word(217), word((1n << 256n) - 1n)];
    const badIndex = job.items.findIndex((item) => candidates.some((answer) => !checkCheckedAnswer(job.taskType, item, answer)));
    if (badIndex === -1) throw new Error('当前输入未配置可验证的无效答案用例');
    answers[badIndex] = candidates.find((answer) => !checkCheckedAnswer(job.taskType, job.items[badIndex], answer));
    found[badIndex] = true;
  }
  return { items: [...job.items], answers, found };
}

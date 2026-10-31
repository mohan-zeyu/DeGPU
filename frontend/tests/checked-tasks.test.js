import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKED_TASKS, NONCE_FIXTURES, KEY_FIXTURES, checkedFixtures, checkedItemsHash,
  checkedSubmission, checkCheckedAnswer, keccak256, word } from '../src/checked-tasks.js';

test('Ethereum Keccak and ABI bytes[] input hashes match upstream golden vectors', () => {
  assert.equal(keccak256('0x'), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(word(42)), '0xbeced09521047d05b8960b7e7bcc1d1292cf3e4b2a6b63f48335cbde5f7545d2');
  assert.equal(checkedItemsHash([NONCE_FIXTURES[0].item]), '0x2c08fe7e1380688999e26344d025d3183a0c3428a6b9e7acd2b6ced3a9b8fcb9');
  assert.equal(checkedItemsHash([NONCE_FIXTURES[0].item, NONCE_FIXTURES[2].item]), '0x5b6f8dd576c9dfa5f5b2b79edf1764a5176dbc8a6e940556c1edbc6b7db82504');
  const key42Range100 = `${keccak256(word(42))}${word(0).slice(2)}${word(100).slice(2)}`;
  assert.equal(checkedItemsHash([key42Range100]), '0xe1f5139dbb47d7052f419c957f488f36cf3d288d347f4cf8e78501958aee445b');
});

test('task IDs follow the upstream Python deployment and use two seconds per item', () => {
  assert.deepEqual(CHECKED_TASKS.map(({ id, chainId, mode, secondsPerItem }) => ({ id, chainId, mode, secondsPerItem })), [
    { id: 'key-search-v1', chainId: 1, mode: 'checked', secondsPerItem: 2 },
  ]);
});

test('nonce checker uses Keccak(challenge || uint256 nonce) and a strict target comparison', () => {
  const challenge = `0x${'11'.repeat(32)}`;
  assert.equal(keccak256(`${challenge}${word(218).slice(2)}`), '0x00b5e20c1a765d2fed0a462f6cb07f269aed058dec77ccb7cbecbc2f462ccd05');
  assert.equal(checkCheckedAnswer('nonce-search-v1', NONCE_FIXTURES[0].item, word(218)), true);
  assert.equal(checkCheckedAnswer('nonce-search-v1', NONCE_FIXTURES[0].item, word(217)), false);
  assert.equal(checkCheckedAnswer('nonce-search-v1', NONCE_FIXTURES[2].item, word(218)), false);
  const digest = keccak256(`${challenge}${word(7).slice(2)}`);
  assert.equal(checkCheckedAnswer('nonce-search-v1', `${challenge}${digest.slice(2)}`, word(7)), false);
  assert.equal(checkCheckedAnswer('nonce-search-v1', `${challenge}${word(BigInt(digest) + 1n).slice(2)}`, word(7)), true);
});

test('key checker has an exclusive upper bound and supports the entire uint256 domain', () => {
  assert.equal(checkCheckedAnswer('key-search-v1', KEY_FIXTURES[0].item, word(42)), true);
  assert.equal(checkCheckedAnswer('key-search-v1', KEY_FIXTURES[0].item, word(43)), false);
  const key = (1n << 200n) + 42n;
  const item = `${keccak256(word(key))}${word(key).slice(2)}${word(key + 1n).slice(2)}`;
  assert.equal(checkCheckedAnswer('key-search-v1', item, word(key)), true);
  const excluded = `${keccak256(word(key))}${word(0).slice(2)}${word(key).slice(2)}`;
  assert.equal(checkCheckedAnswer('key-search-v1', excluded, word(key)), false);
  assert.equal(checkCheckedAnswer('key-search-v1', item, '0x2a'), false);
});

test('fixture variants preserve public inputs and never interpret not-found as a proven absence', () => {
  const taskType = 'nonce-search-v1';
  const items = checkedFixtures(taskType, 3, ['nonce-1', 'nonce-impossible', 'nonce-2']).map((entry) => entry.item);
  const submission = checkedSubmission({ taskType, items, scenario: 'checked-success' });
  assert.deepEqual(submission.found, [true, false, true]);
  submission.found.forEach((found, index) => { if (found) assert.equal(checkCheckedAnswer(taskType, items[index], submission.answers[index]), true); });
  assert.deepEqual(checkedSubmission({ items }, 'checked-none').found, [false, false, false]);
  assert.throws(() => checkedFixtures(taskType, 2, ['nonce-1']));
});

test('fixed ABI tuples accept trailing data and ignore it when checking answers', () => {
  for (const suffix of ['00', word((1n << 256n) - 1n).slice(2)]) {
    assert.equal(checkCheckedAnswer('nonce-search-v1', `${NONCE_FIXTURES[0].item}${suffix}`, word(218)), true);
    assert.equal(checkCheckedAnswer('nonce-search-v1', `${NONCE_FIXTURES[0].item}${suffix}`, word(217)), false);
    assert.equal(checkCheckedAnswer('key-search-v1', `${KEY_FIXTURES[0].item}${suffix}`, word(42)), true);
    assert.equal(checkCheckedAnswer('key-search-v1', `${KEY_FIXTURES[0].item}${suffix}`, word(43)), false);
  }
  assert.equal(checkCheckedAnswer('nonce-search-v1', NONCE_FIXTURES[0].item.slice(0, -2), word(218)), false);
  assert.equal(checkCheckedAnswer('key-search-v1', KEY_FIXTURES[0].item.slice(0, -2), word(42)), false);
});

test('invalid-answer fixtures never mislabel a valid nonce answer as rejected', () => {
  const job = { taskType: 'nonce-search-v1', items: [NONCE_FIXTURES[1].item, NONCE_FIXTURES[0].item] };
  const submission = checkedSubmission(job, 'checked-invalid');
  assert.equal(checkCheckedAnswer(job.taskType, job.items[0], submission.answers[0]), true);
  assert.equal(checkCheckedAnswer(job.taskType, job.items[1], submission.answers[1]), false);
  assert.equal(submission.found[1], true);
  assert.throws(() => checkedSubmission({ ...job, items: [NONCE_FIXTURES[1].item] }, 'checked-invalid'), /未配置可验证的无效答案/);
});

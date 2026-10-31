import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlockTransactions, renderTransactionDetail, renderTransactionRows } from '../src/chain-view.js';

const options = {
  mayView: tx => tx.jobId === 'replicated:7',
  jobHref: id => `#/jobs/${encodeURIComponent(id)}/flow`,
  time: value => `T${value}`,
  shortHash: value => `${value.slice(0, 8)}…`,
  visibleEventArgs: (_job, event) => Object.fromEntries(Object.entries(event.args).filter(([key]) => key !== 'secret')),
};

const network = {
  network: {
    registryAddress: '0xRegistry',
    marketAddress: '0xReplicated',
    markets: { replicated: '0xReplicated', checked: '0xChecked' },
  },
  jobs: [{ id: 'replicated:7' }],
};

const publicTx = overrides => ({
  hash: '0xpubhash', blockNumber: 4, transactionIndex: 0, timestamp: 123,
  from: '0xSender', to: '0xRegistry', contractAddress: null, method: 'register',
  status: 1, gasUsed: 456, jobId: null, events: [], ...overrides,
});

test('block cards render public no-job transactions with type and method, ordered by transaction index', () => {
  const txLater = publicTx({ hash: '0xlater', transactionIndex: 1, method: 'setPrice' });
  const txFirst = publicTx({ hash: '0xfirst', transactionIndex: 0, method: 'register' });
  const html = renderBlockTransactions({ number: 4, transactions: [txLater.hash, txFirst.hash] }, {
    ...network, transactions: [txLater, txFirst],
  }, options);
  assert.ok(html.indexOf('1 · 提供方登记') < html.indexOf('2 · 调整报价'));
  assert.match(html, /register\(\)/);
  assert.match(html, /setPrice\(\)/);
  assert.doesNotMatch(html, /#null/);
});

test('an actually empty block has a clear empty state and no phantom cards', () => {
  const html = renderBlockTransactions({ number: 0, transactions: [] }, { transactions: [] }, options);
  assert.match(html, /区块内交易 · 0 笔/);
  assert.match(html, /该区块没有交易/);
  assert.doesNotMatch(html, /transaction-card/);
});

test('unknown transaction hashes in a block do not create empty or fake records', () => {
  const html = renderBlockTransactions({ transactions: ['0xmissing'] }, { transactions: [] }, options);
  assert.match(html, /区块内交易 · 0 笔/);
  assert.match(html, /该区块没有交易/);
  assert.doesNotMatch(html, /0xmissing/);
});

test('public transaction rows show methods, time, hash, and no null task reference', () => {
  const html = renderTransactionRows([
    publicTx({ hash: '0xnext', transactionIndex: 1, method: 'setPrice' }),
    publicTx({ hash: '0xprior', transactionIndex: 0, method: 'register' }),
  ], { ...options, selectedHash: '0xprior' });
  assert.ok(html.indexOf('<td>0</td>') < html.indexOf('<td>1</td>'));
  assert.match(html, /提供方登记/);
  assert.match(html, /调整报价/);
  assert.match(html, /T123/);
  assert.match(html, /class="selected"/);
  assert.match(html, /<td>—<\/td>/);
  assert.doesNotMatch(html, /#null/);
});

test('nonparticipants see only the task number in rows, cards and transaction detail', () => {
  const tx = publicTx({
    hash: '0xprivatehash', method: 'submitResults', jobId: 'replicated:private-9',
    events: [{ name: 'ResultsPublished', args: { resultHash: 'secret-hash' } }],
  });
  const htmlRows = renderTransactionRows([tx], options);
  const htmlCards = renderBlockTransactions({ transactions: [tx.hash] }, { transactions: [tx] }, options);
  const htmlDetail = renderTransactionDetail(tx, { ...network, jobs: [{ id: tx.jobId }] }, options);
  for (const html of [htmlRows, htmlCards, htmlDetail]) {
    assert.match(html, /replicated:private-9/);
    assert.doesNotMatch(html, /privatehash|submitResults|secret-hash|ResultsPublished/);
  }
  assert.match(htmlDetail, /任务详情仅对参与方开放/);
});

test('a missing task projection remains private instead of being mistaken for a public transaction', () => {
  const tx = publicTx({ hash: '0xunknownjob', jobId: 'checked:999', method: 'acceptJob' });
  const html = renderTransactionDetail(tx, { ...network, jobs: [] }, options);
  assert.match(html, /checked:999/);
  assert.doesNotMatch(html, /0xunknownjob|acceptJob/);
});

test('missing job identity stays private instead of being treated as an explicitly public transaction', () => {
  const tx = publicTx({ jobId: undefined, hash: '0xunknown', method: 'submitResults' });
  const html = renderTransactionDetail(tx, { ...network, jobs: [] }, options);
  assert.match(html, /任务编号未知/);
  assert.match(html, /任务详情仅对参与方开放/);
  assert.doesNotMatch(html, /0xunknown|submitResults/);
});

test('authorized task transaction uses the caller visibility filter for event arguments', () => {
  const tx = publicTx({
    hash: '0xtask', method: 'submitResults', jobId: 'replicated:7',
    events: [{ name: 'ResultsPublished', logIndex: 2, args: { resultHash: 'visible', secret: 'hidden' } }],
  });
  const html = renderTransactionDetail(tx, network, options);
  assert.match(html, /visible/);
  assert.doesNotMatch(html, /hidden|secret/);
  assert.match(html, /replicated:7/);
});

test('deployments resolve their created address and transactions are named from known contract addresses', () => {
  const deployed = publicTx({ method: 'deploy', to: null, contractAddress: '0xRegistry' });
  const deployedHtml = renderTransactionDetail(deployed, network, options);
  assert.match(deployedHtml, /ProviderRegistry/);
  assert.match(deployedHtml, /0xRegistry/);
  const marketTx = publicTx({ method: 'addTaskType', to: '0xCHECKED' });
  const marketHtml = renderTransactionDetail(marketTx, network, options);
  assert.match(marketHtml, /CheckedMarket/);
  assert.match(marketHtml, /0xCHECKED/);
  assert.doesNotMatch(marketHtml, /ReplicatedMarket/);
});

test('public event logs preserve wei units for stake and price fields', () => {
  const tx = publicTx({
    method: 'setPrice',
    events: [{ name: 'PriceSet', logIndex: 0, args: { pricePerItem: '100000000000000', stake: '2500000000000000000' } }],
  });
  const html = renderTransactionDetail(tx, network, options);
  assert.match(html, /pricePerItem/);
  assert.match(html, /stake/);
  assert.equal((html.match(/wei/g) || []).length, 2);
  assert.match(html, /100000000000000/);
  assert.match(html, /2500000000000000000/);
});

test('untrusted transaction strings are escaped in rows, cards and event details', () => {
  const tx = publicTx({
    hash: '<script>alert(1)</script>', method: '<img src=x onerror=1>',
    events: [{ name: '<svg onload=1>', args: { '<b>': '<script>bad()</script>' } }],
  });
  const rows = renderTransactionRows([tx], options);
  const cards = renderBlockTransactions({ transactions: [tx.hash] }, { transactions: [tx] }, options);
  const detail = renderTransactionDetail(tx, network, options);
  for (const html of [rows, cards, detail]) assert.doesNotMatch(html, /<script>|<img|<svg|<b>/);
  assert.match(detail, /&lt;svg onload=1&gt;/);
});

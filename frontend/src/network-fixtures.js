// Deterministic, inspectable local history. Every row is executed through the
// store's normal transaction and settlement paths; no reputation is prefilled.
export const NETWORK_USERS = Object.freeze([
  ['user-01', '林舟', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
  ['user-02', '陈曦', '0xa000000000000000000000000000000000000002'],
  ['user-03', '许悦', '0xa000000000000000000000000000000000000003'],
  ['user-04', '周远', '0xa000000000000000000000000000000000000004'],
  ['user-05', '沈清', '0xa000000000000000000000000000000000000005'],
  ['user-06', '唐宁', '0xa000000000000000000000000000000000000006'],
  ['user-07', '赵禾', '0xa000000000000000000000000000000000000007'],
  ['user-08', '顾言', '0xa000000000000000000000000000000000000008'],
  ['user-09', '陆遥', '0xa000000000000000000000000000000000000009'],
  ['user-10', '苏岚', '0xa00000000000000000000000000000000000000a'],
  ['user-11', '程野', '0xa00000000000000000000000000000000000000b'],
  ['user-12', '叶晴', '0xa00000000000000000000000000000000000000c'],
].map(([id, name, address]) => Object.freeze({ id, name, address })));

export const NETWORK_PROVIDERS = Object.freeze([
  ['A', '青杉计算', '0.000085', '2.400'],
  ['B', '远川节点', '0.00012', '2.100'],
  ['C', '星桥算力', '0.000072', '1.600'],
  ['D', '云岫工作站', '0.00016', '2.800'],
  ['E', '北辰计算', '0.000095', '1.900'],
  ['F', '山海节点', '0.000105', '1.500'],
  ['G', '萤火算力', '0.000065', '1.200'],
  ['H', '溪谷计算', '0.00014', '2.300'],
  ['I', '松间节点', '0.000082', '1.400'],
  ['J', '长风工作站', '0.00019', '2.700'],
  ['K', '极光计算', '0.00011', '1.800'],
  ['L', '原点算力', '0.000075', '1.300'],
  ['M', '竹影节点', '0.000135', '2.000'],
  ['N', '流光计算', '0.00006', '1.100'],
  ['O', '南星工作站', '0.000155', '2.500'],
  ['P', '拾光节点', '0.00009', '1.000'],
].map(([id, name, pricePerItem, stake], index) => Object.freeze({
  id, name, pricePerItem, stake,
  address: `0xb${(index + 1).toString(16).padStart(39, '0')}`,
  ownerId: NETWORK_USERS[index % NETWORK_USERS.length].id,
})));

// Different participation frequencies make price/history comparisons useful
// without inventing a claim that an expensive provider is necessarily better.
const MAIN_COUNTS = [20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
const MODEL_NAMES = ['MobileNetV2.onnx', 'ResNet50.onnx', 'EfficientNet-B0.onnx'];
const ITEM_COUNTS = [48, 64, 96, 128, 160, 200, 240, 320, 400, 512];

export function networkHistoryInputs() {
  const providers = MAIN_COUNTS.flatMap((count, index) => Array(count).fill(NETWORK_PROVIDERS[index].id));
  // A fixed permutation avoids chronological runs of one provider while
  // keeping resets reproducible and tests independent of Math.random().
  let seed = 92731;
  for (let index = providers.length - 1; index > 0; index -= 1) {
    seed = (seed * 16807) % 2147483647;
    const target = seed % (index + 1);
    [providers[index], providers[target]] = [providers[target], providers[index]];
  }
  return providers.map((provider, index) => ({
    provider,
    clientId: NETWORK_USERS[(index * 5 + 1) % NETWORK_USERS.length].id,
    itemCount: ITEM_COUNTS[index % ITEM_COUNTS.length],
    modelName: MODEL_NAMES[index % MODEL_NAMES.length],
    scenario: [17, 52, 98].includes(index) ? 'main-offline'
      : [39, 91].includes(index) ? 'main-cheat'
        : index === 71 ? 'verifier-cheat'
          : index === 115 ? 'verifier-offline'
            : index % 5 === 0 ? 'unverified' : 'verified',
  }));
}

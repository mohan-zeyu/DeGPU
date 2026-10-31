import { getService, servicesForState } from './services.js';
import { getRentedProviderIds } from './market.js';
import { getProviderPublicStats } from './provider-stats.js';
import { getProviderAvailability } from './provider-availability.js';

const WEI = 10n ** 18n;
const OWNERSHIPS = new Set(['all', 'other', 'own', 'rented']);
const AVAILABILITIES = new Set(['all', 'available', 'unavailable']);
const COMMON_SORTS = new Set(['available', 'price-asc', 'price-desc', 'completed-desc',
  'timeoutRate-asc', 'failureRate-asc']);
const TABLE_SORTS = new Set(['id', 'active', 'stake', 'lockedJobs', 'totalCompleted',
  'imageQuote', 'renderQuote', 'keyQuote'].flatMap(key => [`${key}-asc`, `${key}-desc`]));
const QUOTE_FIELDS = Object.freeze({ imageQuote: 'image-classify-v1',
  renderQuote: 'blender-render-v1', keyQuote: 'key-search-v1' });
const ids = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function quoteWei(value) {
  const match = typeof value === 'string' && /^(\d+)(?:\.(\d{1,18}))?$/.exec(value);
  return match ? BigInt(match[1]) * WEI + BigInt((match[2] ?? '').padEnd(18, '0')) : null;
}

// Unknown measurements stay last even when the requested direction reverses.
function compareKnown(left, right, descending = false) {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  const result = left < right ? -1 : left > right ? 1 : 0;
  return descending ? -result : result;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeSort(value, taskType) {
  const mode = getService(taskType)?.mode;
  return COMMON_SORTS.has(value) || TABLE_SORTS.has(value)
    || (value === 'outvotedRate-asc' && mode === 'replicated')
    || (value === 'notFoundRate-asc' && mode === 'checked') ? value : 'available';
}

const count = value => ['string', 'number', 'bigint'].includes(typeof value)
  && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function totalCompleted(provider, typedStats, state) {
  // The current backend's registry counters cover both replicated task types.
  // Add each mode once; never present these totals as per-task statistics.
  if (provider.record && typeof provider.record === 'object') {
    const counters = [provider.record.replicated?.verified_completed ?? 0,
      provider.record.replicated?.unverified_completed ?? 0,
      provider.record.checked?.completed ?? 0].map(count);
    const total = counters.every(value => value !== null) ? counters.reduce((sum, value) => sum + value, 0) : null;
    return Number.isSafeInteger(total) ? total : null;
  }
  const hasHistory = typedStats.some(stats => stats.mainResolved > 0)
    || state.network?.historyComplete === true && state.network?.historyFromBlock === 0 && Array.isArray(state.jobs);
  return hasHistory ? typedStats.reduce((sum, stats) => sum + (stats.completed ?? 0), 0) : null;
}

// Sort a copied public projection. Wei comparisons retain all 18 decimal places,
// and missing values remain last in both directions.
export function sortMarketRows(rows, sort = 'id-asc', taskType = 'image-classify-v1') {
  const ordering = normalizeSort(sort, taskType);
  return [...(rows ?? [])].sort((left, right) => {
    const metric = (key, descending = false) => compareKnown(left.stats?.[key], right.stats?.[key], descending);
    const price = (service, descending = false) => compareKnown(
      quoteWei(service ? left.stats?.quotes?.[service] : left.stats?.quote),
      quoteWei(service ? right.stats?.quotes?.[service] : right.stats?.quote), descending);
    let order = 0;
    if (ordering === 'available') {
      order = Number(right.availability.available) - Number(left.availability.available)
        || price() || metric('completed', true);
    } else {
      const direction = ordering.endsWith('-desc');
      const key = ordering.replace(/-(?:asc|desc)$/, '');
      if (key === 'id') order = ids.compare(String(left.id ?? ''), String(right.id ?? '')) * (direction ? -1 : 1);
      else if (key === 'price') order = price(null, direction);
      else if (key === 'stake') order = compareKnown(quoteWei(left.stats?.stake), quoteWei(right.stats?.stake), direction);
      else if (QUOTE_FIELDS[key]) order = price(QUOTE_FIELDS[key], direction);
      else order = metric(key, direction);
    }
    return order || ids.compare(String(left.id ?? ''), String(right.id ?? ''));
  });
}

// A list has one row per registered machine, including paused and delisted
// machines. Each row is a public projection: no provider or private job object
// crosses into the view merely to support searching, ordering or pagination.
export function getMarketList(state, {
  taskType = 'image-classify-v1', account = state?.account, ownedProviderIds = [],
  connectivityByProvider = {}, ownership = 'all', availability = 'all',
  sort = 'id-asc', query = '', page = 1, pageSize = null,
} = {}) {
  const source = state ?? {};
  const owned = new Set(ownedProviderIds ?? []);
  const rented = new Set(getRentedProviderIds(source, { account }));
  const identityFilter = OWNERSHIPS.has(ownership) ? ownership : 'all';
  const availabilityFilter = AVAILABILITIES.has(availability) ? availability : 'all';
  const ordering = normalizeSort(sort, taskType);
  const search = typeof query === 'string' ? query.trim() : '';
  const needle = search.toLocaleLowerCase();
  const providers = (source.providers ?? []).filter(provider => provider.registered === true);
  const matches = providers.flatMap(provider => {
    const identity = owned.has(provider.id) ? 'own' : rented.has(provider.id) ? 'rented' : 'other';
    if (identityFilter !== 'all' && identity !== identityFilter) return [];
    if (needle && ![provider.id, provider.name, provider.address]
      .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(needle))) return [];
    const status = getProviderAvailability(provider, taskType, {
      connectivity: connectivityByProvider?.[provider.id],
    });
    if (availabilityFilter !== 'all' && status.available !== (availabilityFilter === 'available')) return [];
    const typedStats = servicesForState(source)
      .map(service => getProviderPublicStats(source, provider.id, service.id));
    const selectedStats = typedStats.find(stats => stats.taskType === taskType)
      ?? getProviderPublicStats(source, provider.id, taskType);
    const stats = Object.freeze({ ...selectedStats,
      name: typeof provider.name === 'string' ? provider.name : null,
      quotes: Object.freeze(Object.fromEntries(typedStats.map(stats => [stats.taskType, stats.quote]))),
      totalCompleted: totalCompleted(provider, typedStats, source),
    });
    const row = Object.freeze({ id: stats?.id ?? null, address: stats?.address ?? null,
      stats, availability: status, identity });
    return [row];
  });
  const orderedRows = sortMarketRows(matches, ordering, taskType);
  const size = positiveInteger(pageSize, Math.max(matches.length, 1));
  const pageCount = Math.max(1, Math.ceil(matches.length / size));
  const currentPage = Math.min(positiveInteger(page, 1), pageCount);
  return Object.freeze({
    rows: Object.freeze(orderedRows.slice((currentPage - 1) * size, currentPage * size)),
    total: providers.length, filteredTotal: matches.length, page: currentPage, pageCount,
    ownership: identityFilter, availability: availabilityFilter, sort: ordering, query: search,
  });
}

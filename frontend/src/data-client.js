import { createDemoStore } from './demo-store.js';
import { createNetworkClient } from './network-client.js';

// Keep the UI independent of Solidity ABI details and the Python CLI.
// Adapters return the same normalized view; live operations are acknowledged
// only after an actual response from the connection service.
export function createDataClient(adapter) {
  const required = ['getState', 'subscribe', 'createJob', 'advanceJob', 'passDeadline', 'expireJob', 'reset'];
  for (const method of required) {
    if (typeof adapter[method] !== 'function') throw new TypeError(`Missing data adapter method: ${method}`);
  }
  // Optional capabilities; existing adapters retain their required interface.
  const optional = ['createJobsInBlock', 'selectAccount', 'registerAccount', 'registerMachine', 'cancelJob', 'submitResults', 'acceptResults', 'disputeResults', 'updateProviderOffers', 'setProviderListing'].filter(method => typeof adapter[method] === 'function');
  return Object.freeze(Object.fromEntries([...required, ...optional].map(method => [method, (...args) => adapter[method](...args)])));
}

// Offline fixtures are an explicit development mode, never an automatic
// replacement for an unavailable live backend. Node tests keep their adapter.
const offline = typeof window === 'undefined' || new URLSearchParams(window.location.search).get('mode') === 'demo';
export const client = offline ? createDataClient(createDemoStore({ profile: 'network' })) : createNetworkClient();

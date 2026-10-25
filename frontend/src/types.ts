// The shapes the DeGPU app sends (docs/API.md, docs/FRONTEND.md section 5).

export type Wei = string; // decimal string, e.g. "1000000000000000000" = 1 ETH
export type Address = string; // "0x…" checksummed
export type Mode = "replicated" | "checked";
export type Behavior = "honest" | "cheat" | "liar" | "offline";
export type BigNum = number | string; // a string from 2^53 up

export interface NetworkInfo {
  url: string;
  name: string;
  chain_id: number;
  registry: Address;
  faucet_wei: Wei;
}

export interface Status {
  network: NetworkInfo | { url: string } | null; // only {url} while locked
  wallet: { name: string; address: Address } | null;
  unlocked: boolean;
  serving: boolean;
}

export interface WalletEntry {
  name: string;
  address: Address;
}

export interface Account {
  address: Address;
  balance_wei: Wei;
}

export interface FaucetReply {
  address: Address;
  amount_wei: Wei;
  tx: string;
}

export interface ActivityLine {
  seq: number;
  time: number;
  message: string;
}

export interface TaskField {
  name: string;
  flag: string;
  type: "int" | "float" | "str" | "bool" | "file" | "files";
  default: number | string | boolean | null;
  help: string | null;
}

export interface TaskInfo {
  name: string;
  mode: Mode;
  description: string;
  task_id: number;
  default_price_wei: Wei;
  runs_here: boolean;
  result: "value" | "file";
  fields: TaskField[];
  code_matches?: boolean;
}

export interface Provider {
  address: Address;
  registered: boolean;
  active: boolean;
  stake_wei: Wei;
  open_jobs: number;
  prices_wei: Record<string, Wei>;
  record: Partial<Record<Mode, Record<string, number>>>;
}

export interface MeAsProvider extends Provider {
  serving: boolean;
  behavior: Behavior;
  min_stake_wei: Wei;
  warning?: string;
}

export type Role = "client" | "main" | "verifier" | "tiebreaker" | "provider" | null;
export type Outcome =
  | "none" | "cancelled" | "delivered" | "verified" | "main_outvoted" | "verifier_outvoted"
  | "both_outvoted" | "no_majority" | "main_missed" | "tiebreaker_missed" | "tie_client_no_share"
  | "dispute_rejected";
export type VerifierState =
  | "none" | "assigned" | "shared" | "committed" | "revealed" | "no_share" | "bad_input" | "missed"
  | "outvoted";

export interface JobSummary {
  ref: string;
  mode: Mode;
  id: number;
  task: string;
  role: Role;
  status: string;
  outcome: Outcome;
  closed: boolean;
  client: Address;
  main: Address;
  num_items: number;
  deposit_wei: Wei;
  deadline: number;
}

export interface TimelineEvent {
  event: string;
  block: number;
  time: number;
  args: Record<string, unknown>;
}

export interface JobDetail extends JobSummary {
  timeline: TimelineEvent[];
  verifiers?: { address: Address; state: VerifierState; items: [number, number] }[];
  tiebreaker?: Address | null;
  decided?: boolean;
  verified?: boolean;
  dropped?: "none" | "client_no_reveal" | "no_eligible_verifier";
  mismatched?: number[];
  dispute_bond_wei?: Wei;
  solved?: number;
}

export type Results =
  | { ref: string; kind: "value"; items: { index: number; value: BigNum | null; mismatched: boolean }[] }
  | {
      ref: string;
      kind: "file";
      suffix: string;
      items: { index: number; file: string | null; size: number | null; mismatched: boolean }[];
    };

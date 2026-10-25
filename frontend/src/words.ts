// What the GUI says for each code the API returns (docs/FRONTEND.md section 4).

import { formatEth, short, sameAddress } from "./format";
import type { Mode, Outcome, Role, VerifierState } from "./types";

export type Tone = "good" | "neutral" | "warn" | "bad" | "info";

export const MODE_WORDS: Record<Mode, string> = {
  replicated: "Checked by re-running on other providers",
  checked: "Every answer checked by the contract",
};

export const STATUS_WORDS: Record<string, string> = {
  open: "Waiting for the provider to accept",
  committing: "The provider is computing",
  deciding: "Your app is revealing the secret decision",
  checking: "Verifiers are re-running the work",
  check_reveal: "Verifiers are showing their results",
  publishing: "The provider is publishing the results",
  disputing: "The client's app is comparing the rendered frames",
  tie_break: "A tie-breaker is settling a disagreement",
  working: "The provider is solving the puzzles",
  closed: "Finished",
};

/** stamp: the few words on the stamp; text: the sentence under it. */
export const OUTCOMES: Record<Outcome, { stamp: string; text: string; tone: Tone }> = {
  none: { stamp: "Running", text: "Still running", tone: "neutral" },
  cancelled: { stamp: "Cancelled", text: "Cancelled. The deposit went back to the client.", tone: "neutral" },
  delivered: { stamp: "Delivered", text: "Done, without verification.", tone: "info" },
  verified: { stamp: "Verified", text: "Done, and every item was checked by two other providers.", tone: "good" },
  main_outvoted: {
    stamp: "Cheater caught",
    text: "The provider's results were wrong. It was slashed, and the client was compensated.",
    tone: "bad",
  },
  verifier_outvoted: {
    stamp: "Verifier caught",
    text: "A verifier was wrong and was slashed. The provider's results are right.",
    tone: "warn",
  },
  both_outvoted: { stamp: "Both caught", text: "The provider and a verifier were each wrong on some items.", tone: "bad" },
  no_majority: { stamp: "No majority", text: "Some items couldn't be settled.", tone: "warn" },
  main_missed: {
    stamp: "Provider missed",
    text: "The provider missed its deadline and was slashed. The client was refunded.",
    tone: "bad",
  },
  tiebreaker_missed: { stamp: "Tie-break missed", text: "The tie-breaker missed its deadline.", tone: "warn" },
  tie_client_no_share: {
    stamp: "Not shared",
    text: "The client's app didn't send the disputed items in time.",
    tone: "warn",
  },
  dispute_rejected: {
    stamp: "Dispute rejected",
    text: "The client's dispute was wrong. Its bond paid the tie-breaker.",
    tone: "warn",
  },
};

export const ROLE_WORDS: Record<string, string> = {
  client: "You bought this",
  main: "You did the work",
  verifier: "You checked the work",
  tiebreaker: "You settled a disagreement",
  provider: "You worked on this",
};

export function roleWords(role: Role): string {
  return role ? ROLE_WORDS[role] ?? role : "Not your job";
}

export const VSTATE_WORDS: Record<VerifierState, { text: string; tone: Tone }> = {
  none: { text: "Not drawn", tone: "neutral" },
  assigned: { text: "Drawn, waiting for the items", tone: "neutral" },
  shared: { text: "Re-running", tone: "info" },
  committed: { text: "Finished, result sealed", tone: "info" },
  revealed: { text: "Result shown", tone: "good" },
  no_share: { text: "Never got the items (still paid)", tone: "warn" },
  bad_input: { text: "Reported the items as broken", tone: "warn" },
  missed: { text: "Missed the deadline (slashed)", tone: "bad" },
  outvoted: { text: "Was wrong (slashed)", tone: "bad" },
};

export const RECORD_WORDS: Record<string, string> = {
  verified_completed: "Verified jobs done",
  unverified_completed: "Unverified jobs done",
  missed: "Deadlines missed",
  outvoted: "Caught with wrong results",
  checks_completed: "Checks done",
  checks_missed: "Checks missed",
  checks_outvoted: "Wrong checks",
  completed: "Puzzle jobs done",
  items_solved: "Puzzles solved",
  items_not_found: "Puzzles with no answer",
};

function who(addr: unknown, me: string): string {
  return sameAddress(String(addr), me) ? "you" : short(String(addr));
}

function amount(v: unknown): string {
  return formatEth(BigInt(String(v)));
}

/** One timeline event in words. */
export function eventWords(event: string, args: Record<string, unknown>, me: string): string {
  switch (event) {
    case "JobCreated":
      return "Job posted";
    case "JobAccepted":
      return "The provider accepted";
    case "ResultsCommitted":
      return "The provider sealed its results";
    case "DecisionRevealed":
      return args.verify ? "Secret decision revealed: verify" : "Secret decision revealed: don't verify";
    case "VerificationDropped":
      return Number(args.reason) === 1
        ? "Verification skipped: the decision wasn't revealed in time"
        : "Verification skipped: not enough providers";
    case "VerifiersDrawn":
      return "Two verifiers drawn at random";
    case "RangeShared":
      return `Items sent to verifier ${who(args.verifier, me)}`;
    case "CheckCommitted":
      return "A verifier sealed its check";
    case "CheckRevealed":
      return "A verifier showed its check";
    case "VerifierDropped":
      return "A verifier dropped out";
    case "ResultsPublished":
      return "Results published";
    case "ResultsSubmitted":
      return "Answers submitted and checked by the contract";
    case "ResultsDisputed":
      return "The client disputed some frames";
    case "TiebreakStarted":
      return `Tie-breaker ${who(args.tiebreaker, me)} drawn`;
    case "TiebreakShared":
      return "Disputed items sent to the tie-breaker";
    case "TiebreakSubmitted":
    case "JudgementSubmitted":
      return "The tie-breaker decided";
    case "ProviderSlashed":
      return `${who(args.provider, me) === "you" ? "You" : who(args.provider, me)} lost ${amount(args.amount)} of stake`;
    case "Payout":
      return `${amount(args.amount)} paid to ${who(args.to, me)}`;
    case "JobClosed":
      return "Job closed";
    default:
      return event;
  }
}

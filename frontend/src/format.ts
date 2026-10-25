// Money, addresses and times. Wei always stays a string or a BigInt: 1 ETH is bigger than 2^53.

const WEI = 10n ** 18n;

/** "1500000000000000000" -> "1.5 ETH" (at most `digits` decimals, trailing zeros cut) */
export function formatEth(wei: string | bigint, digits = 6): string {
  const v = BigInt(wei);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % WEI).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  const tiny = a > 0n && a / WEI === 0n && !frac;
  return tiny ? `${neg ? "-" : ""}< 0.${"0".repeat(digits - 1)}1 ETH` : `${neg ? "-" : ""}${a / WEI}${frac ? "." + frac : ""} ETH`;
}

/** What the user typed ("0.25") -> wei string. Throws with a message for the user. */
export function parseEth(text: string): string {
  const m = text.trim().match(/^(\d+)(?:\.(\d{0,18}))?$/) ?? text.trim().match(/^()\.(\d{1,18})$/);
  if (!m) throw new Error("Type an amount of ETH, like 0.25");
  return (BigInt(m[1] || "0") * WEI + BigInt((m[2] ?? "").padEnd(18, "0"))).toString();
}

/** Wei -> the plain number text for an ETH input field ("0.0001"). */
export function ethInput(wei: string): string {
  return formatEth(wei, 18).replace(" ETH", "");
}

export function short(addr: string | null | undefined): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Unix seconds -> "14:05:09" */
export function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/** Seconds left until `deadline`, as "4 min 10 s", or null once it passed. */
export function timeLeft(deadline: number, now: number): string | null {
  const s = Math.floor(deadline - now);
  if (s <= 0) return null;
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

/** "find the key" -> "Find the key." */
export function sentence(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : t;
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Number of frames in a frame list: "1-12" -> 12, "1,5,9" -> 3, "1-4,9" -> 5; null if unreadable. */
export function countFrames(spec: string): number | null {
  let n = 0;
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    n += m[2] ? Math.max(0, Number(m[2]) - Number(m[1]) + 1) : 1;
  }
  return n;
}

// The voiceover. Per scene, one entry per spoken line:
//   at    scene-local time (in the scene's own animation clock) where the line starts
//   text  the subtitle (HTML allowed)
//   say   what the voice reads, when it differs from the subtitle (numbers spelled out;
//         "Eh" for provider A, which the TTS would otherwise read as the article "uh")
//   hold  optional: where the animation pauses if the line outlasts the gap to the next one
//         (by default the engine picks the latest moment where nothing is moving)
//   cap   false to speak without a subtitle
// Names, counts and labels come from the captured demo run (data.js).
(() => {
  const D = window.DATA;
  const J2 = D.jobs["2"], J3 = D.jobs["3"], J4 = D.jobs["4"];
  const say = (n) => (n === "A" ? "Eh" : n);
  const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const words = (n) => {
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
    return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + words(n % 100) : "");
  };
  const label = (k) => D.classNames[k] ?? `class #${k}`;
  const sayLabel = (k) => D.classNames[k] ?? `class ${words(k)}`;

  const [v2a, v2b] = J2.verifiers;
  const M3 = J3.main, [v3a, v3b] = J3.verifiers, tb3 = J3.tiebreaker;
  const faked = J3.agents[M3].cheated, n3 = faked.length;
  const zi = faked.find((i) => D.classNames[D.expected[i]] && i >= 20) ?? faked[0];
  const vz = zi < 100 ? v3a : v3b;
  const [v4a, v4b] = J4.verifiers, tb4 = J4.tiebreaker;
  const ST = (i) => 1.9 + 2.62 * i; // step times of the job-flow scene

  window.NARRATION = {
    intro: [
      { at: 1.4, text: "This is DeGPU, our course project: a small decentralized marketplace for renting compute, where any job can be secretly checked.",
        say: "This is Dee G P U, our course project: a small, decentralized marketplace for renting compute, where any job can be secretly checked." },
    ],
    problem: [
      { at: 0.5, text: "Renting GPU time from strangers is cheap. But how do you know they actually did the work?" },
      { at: 3.3, text: "A provider could skip it, send back <b>made-up labels</b>, and still get paid." },
      { at: 8.6, text: "DeGPU makes that a <b>losing bet</b>, without anyone having to trust anyone.",
        say: "Dee G P U makes that a losing bet, without anyone having to trust anyone." },
    ],
    what: [
      { at: 0.6, hold: 3.6, text: "DeGPU rests on three ideas.", say: "Dee G P U rests on three ideas." },
      { at: 4.8, hold: 5.4, text: "<b>Money lives on-chain</b>: deposits, stakes, payouts and slashes are all handled by smart contracts." },
      { at: 6.5, hold: 7.1, text: "<b>Compute stays off-chain</b>, on the providers’ own machines." },
      { at: 8.2, hold: 8.8, text: "And some jobs are <b>secretly re-run</b> by random providers, so cheaters lose their stake." },
      { at: 10.0, text: "Our first job type labels a batch of photos with an ImageNet model." },
    ],
    arch: [
      { at: 0.8, hold: 6.7, text: "There are four parts. On a local Ethereum chain, a <b>registry</b> holds provider stakes and reputation, and a <b>job market</b> runs each job." },
      { at: 7.0, text: "Off-chain, the <b>client</b> encrypts and posts jobs, <b>storage</b> holds the encrypted files, and provider <b>agents</b> run the model." },
    ],
    hidden: [
      { at: 0.9, hold: 4.58, text: "Here’s the key idea. When posting a job, the client <b>secretly decides</b> whether it will be checked." },
      { at: 4.6, hold: 7.55, text: "Only a <b>hash</b> of that choice goes on-chain, and the deposit is the same either way." },
      { at: 7.6, hold: 10.2, text: "So a checked job and an unchecked job look <b>exactly the same</b>." },
      { at: 14.6, hold: 16.7, text: "The choice is revealed only <b>after</b> the provider commits to its results." },
      { at: 17.0, text: "So the provider can’t tell which jobs are checked, and has to do <b>every</b> job honestly." },
    ],
    flow: [
      { at: ST(0), cap: false, say: "Here's a job, step by step. The client posts encrypted photos, a deposit, and its hidden decision." },
      { at: ST(1), cap: false, say: "The main provider checks the inputs, accepts, and runs the model." },
      { at: ST(2), cap: false, say: "It commits to a hash of its results, before knowing if it will be checked." },
      { at: ST(3), cap: false, say: "Then the client reveals its decision." },
      { at: ST(4), cap: false, say: "If it's no, the provider is paid, and the client gets half its deposit back." },
      { at: ST(5), cap: false, say: "If it's yes, two random verifiers each re-run half the items." },
      { at: ST(6), cap: false, say: "The contract compares every item, hash against hash." },
      { at: ST(7), cap: false, say: "If all of them match, everyone is paid." },
      { at: ST(8), cap: false, say: "If not, a random tie-breaker settles each disputed item, and whoever is outvoted gets slashed." },
    ],
    privacy: [
      { at: 0.8, hold: 4.8, text: "Every photo is encrypted, and each party gets only the keys it needs." },
      { at: 5.0, text: "The main provider sees all 200 items, each verifier only its half, and the tie-breaker only the disputed ones.",
        say: "The main provider sees all two hundred items, each verifier only its half, and the tie-breaker only the disputed ones." },
      { at: 9.0, text: "On-chain there are only <b>salted hashes</b>, so results can be compared without revealing a single label." },
    ],
    demo: [
      { at: 0.8, hold: 3.2, text: "Now the live demo: a fresh local chain with six providers, A to F, each staking one ether.",
        say: "Now the live demo: a fresh local chain with six providers, Eh to F, each staking one ether." },
      { at: 3.4, text: "Every number you’ll see comes from that real run." },
    ],
    s1: [
      { at: 0.9, text: "Scenario one. The client posts 200 photos to provider A, and secretly chooses <b>not</b> to verify.",
        say: "Scenario one. The client posts two hundred photos to provider Eh, and secretly chooses not to verify." },
      { at: 4.2, text: "A runs the model and commits to a hash of its results.", say: "Eh runs the model, and commits to a hash of its results." },
      { at: 8.3, text: "The client reveals “no”, and A publishes and is paid.", say: "The client reveals no, and Eh publishes, and is paid." },
      { at: 12.4, text: "Delivered. The client paid <b>0.020 ETH</b> and got the other half of its deposit back.",
        say: "Delivered. The client paid point zero two ether, and got the other half of its deposit back." },
    ],
    s2: [
      { at: 0.9, text: "Scenario two looks identical on-chain, but this time the secret answer is <b>yes</b>." },
      { at: 6.2, text: "After A commits, the client reveals “yes”, and the contract draws <b>two random verifiers</b>.",
        say: "After Eh commits, the client reveals yes, and the contract draws two random verifiers." },
      { at: 9.2, text: `${v2a} re-runs the first hundred items, and ${v2b} the second hundred.`,
        say: `${say(v2a)} re-runs the first hundred items, and ${say(v2b)}, the second hundred.` },
      { at: 12.1, text: "Both commit before either reveals, so neither can copy." },
      { at: 15.3, text: "A publishes, and all 200 results match.", say: "Eh publishes, and all two hundred results match." },
      { at: 18.4, text: "Verified. The client paid <b>0.040 ETH</b>, split between A and the two verifiers.",
        say: "Verified. The client paid point zero four ether, split between Eh and the two verifiers." },
    ],
    s3: [
      { at: 0.9, text: `Scenario three has a cheater. Provider ${M3} fakes ${n3} of its 200 labels.`,
        say: `Scenario three has a cheater. Provider ${say(M3)} fakes ${words(n3)} of its two hundred labels.` },
      { at: 5.2, text: `It commits without knowing the job will be checked. The answer is “yes”, and ${v3a} and ${v3b} are drawn as verifiers.`,
        say: `It commits without knowing the job will be checked. The answer is yes, and ${say(v3a)} and ${say(v3b)} are drawn as verifiers.` },
      { at: 9.0, text: `They re-run every item. Then ${M3} publishes its results.`, say: `They re-run every item. Then ${say(M3)} publishes its results.` },
      { at: 15.0, text: `The contract flags <b>exactly the ${n3} faked items</b>. Every item is checked, so there’s no luck involved.`,
        say: `The contract flags exactly the ${words(n3)} faked items. Every item is checked, so there's no luck involved.` },
      { at: 19.4, hold: 20.9, text: `Item ${zi}, for example: ${M3} said “${label(J3.agents[M3].labels[zi])}”, but ${vz} says “${label(D.expected[zi])}”.`,
        say: `Item ${words(zi)}, for example: ${say(M3)} said ${sayLabel(J3.agents[M3].labels[zi])}, but ${say(vz)} says ${sayLabel(D.expected[zi])}.` },
      { at: 22.2, text: `A random tie-breaker, ${tb3}, re-runs just those ${n3} items.`,
        say: `A random tie-breaker, ${say(tb3)}, re-runs just those ${words(n3)} items.` },
      { at: 27.0, text: `The majority wins. ${M3} loses <b>0.3 ETH</b> of stake and is suspended, and the client receives the slash: <b>+0.278 ETH</b>.`,
        say: `The majority wins. ${say(M3)} loses point three ether of stake, and is suspended. And the client receives the slash: plus point two seven eight ether.` },
    ],
    s4: [
      { at: 0.9, text: "Scenario four: main provider A is honest, but the other providers <b>lie</b> as verifiers.",
        say: "Scenario four: main provider Eh is honest, but the other providers lie as verifiers." },
      { at: 5.3, text: `${v4a} and ${v4b} are drawn, and make up random labels instead of running the model.`,
        say: `${say(v4a)} and ${say(v4b)} are drawn, and make up random labels instead of running the model.` },
      { at: 12.4, text: `Every item mismatches, so tie-breaker ${tb4} re-runs all 200, and agrees with A.`,
        say: `Every item mismatches, so tie-breaker ${say(tb4)} re-runs all two hundred, and agrees with Eh.` },
      { at: 20.0, text: "Both liars lose <b>0.3 ETH</b>. A is still paid, and the client nets <b>+0.578 ETH</b>.",
        say: "Both liars lose point three ether. Eh is still paid, and the client nets plus point five seven eight ether." },
    ],
    s5: [
      { at: 0.9, text: "Finally, F accepts a job and then goes silent." },
      { at: 5.6, text: "Every phase has a deadline. We fast-forward the chain past it, and <b>anyone</b> can call <span class=mono>expire()</span>.",
        say: "Every phase has a deadline. We fast-forward the chain past it, and anyone can call expire." },
      { at: 10.8, text: "F is slashed <b>0.1 ETH</b>, and the client gets its deposit back plus the slash.",
        say: "F is slashed point one ether, and the client gets its deposit back, plus the slash." },
    ],
    tests: [
      { at: 0.8, text: "None of this is eyeballed: the demo script asserts every outcome and every balance." },
      { at: 9.8, text: "All five scenarios pass." },
      { at: 12.2, text: "The contracts have <b>67 Solidity tests</b>,", say: "The contracts have sixty-seven Solidity tests," },
      { at: 14.6, text: "and the Python code has <b>55 more</b>, including end-to-end runs on a real chain.",
        say: "and the Python code has fifty-five more, including end-to-end runs on a real chain." },
    ],
    rep: [
      { at: 0.8, hold: 3.2, text: "The registry keeps each provider’s stake and track record." },
      { at: 3.3, text: "B and E fell below the <b>0.8 ETH</b> minimum, so they’re suspended.",
        say: "B and E fell below the point eight ether minimum, so they're suspended." },
    ],
    econ: [
      { at: 0.8, hold: 3.0, text: "Why doesn’t cheating pay? Faking earns at most the job price: <b>0.020 ETH</b>.",
        say: "Why doesn't cheating pay? Faking earns at most the job price: point zero two ether." },
      { at: 4.0, hold: 7.2, text: "Getting caught costs <b>0.3 ETH</b>, fifteen times more.", say: "Getting caught costs point three ether. Fifteen times more." },
      { at: 8.4, text: "So checking even <b>1 job in 15</b> makes faking a losing bet, and the provider can’t tell which one it is.",
        say: "So checking even one job in fifteen makes faking a losing bet, and the provider can't tell which one it is." },
    ],
    limits: [
      { at: 0.8, text: "Some things are deliberately out of scope for a course project." },
      { at: 3.4, text: "The main provider sees every image, verification doubles the cost, and the randomness is demo-grade." },
      { at: 3.5, text: "Results all go on-chain, and storage is a local folder, not IPFS. The README covers each one.",
        say: "Results all go on-chain, and storage is a local folder, not I P F S. The read me covers each one." },
    ],
    try: [
      { at: 0.8, text: "To try it, fetch the model and photos, then run the tests and the demo." },
      { at: 4.0, text: "Everything runs locally. The README has the details.", say: "Everything runs locally. The read me has the details." },
    ],
    outro: [
      { at: 1.2, cap: false, say: "Thanks for watching!" },
    ],
  };
})();

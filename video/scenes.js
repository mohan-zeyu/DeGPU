// The storyboard. Chapters: 0 Overview, 1 How it works, 2 Live demo, 3 Wrap-up.

const commitOf = (sc) => "0x" + sc.timeline[0][1].match(/hidden: ([0-9a-f]+)/)[1];
const PICKS = [0, 20, 82, 101, 121, 141, 160, 180]; // one photo per class, for the photo strip

// ================================================================ 0. intro
scene({
  id: "intro", dur: 9.5, chapter: null,
  build(root) {
    const logo = add(root, `<div class="abs" style="left:0;right:0;top:300px;display:flex;justify-content:center">${logoSVG(136)}</div>`);
    const word = add(root, `<div class="abs" style="left:0;right:0;top:448px;text-align:center;font-size:150px;font-weight:800;letter-spacing:-.03em;line-height:1"><span class="grad">De</span>GPU</div>`);
    const tag = add(root, `<div class="abs" style="left:0;right:0;top:640px;text-align:center;font-size:38px;color:var(--muted);font-weight:400">A decentralized marketplace for <span style="color:var(--text);font-weight:500">verifiable compute</span></div>`);
    const meta = add(root, `<div class="abs" style="left:0;right:0;top:724px;text-align:center;font-size:18px;letter-spacing:.24em;color:var(--dim);font-weight:650">BLOCKCHAIN COURSE PROJECT &nbsp;·&nbsp; TEAM WALKTHROUGH &nbsp;·&nbsp; V2</div>`);
    return (t) => {
      show(logo, t, 0.6, Infinity, { d: 1.2, dy: 0, s0: 0.75, blur: 12, e: E.outQuint });
      const p = P(t, 1.1, 1.8, E.outQuint);
      word.style.opacity = p;
      word.style.letterSpacing = lerp(0.3, -0.03, p) + "em";
      word.style.filter = p < 0.99 ? `blur(${(1 - p) * 14}px)` : "none";
      show(tag, t, 2.4, Infinity, { d: 1.1 });
      show(meta, t, 3.2, Infinity, { d: 1.1 });
    };
  },
});

// ================================================================ 1. the problem
scene({
  id: "problem", dur: 12, chapter: 0,
  build(root) {
    const hd = header(root, "The problem", "Renting compute from strangers is cheap.", null, "var(--bad)");
    const l2 = add(root, `<div class="h1 abs" style="left:118px;top:208px;color:var(--muted)">But did they actually <span style="color:var(--text)">do the work?</span></div>`);
    const team = add(root, `<div class="card abs" style="left:200px;top:480px;width:330px;height:220px;padding:30px">
        <div class="iconbox" style="--c:var(--client)">${ic("team", 34)}</div>
        <div style="font-size:30px;font-weight:700;margin-top:20px">Your team</div>
        <div style="font-size:21px;color:var(--muted);margin-top:6px">200 photos to label</div></div>`);
    const got = add(root, `<div class="pill abs" style="left:236px;top:720px;background:rgba(96,165,250,.14);color:var(--main);font-size:19px">${ic("check", 18)} 200 labels received</div>`);
    const pos = [[1180, 420], [1360, 420], [1540, 420], [1180, 590], [1360, 590], [1540, 590]];
    const provs = pos.map(([x, y]) => add(root, `<div class="card abs" style="left:${x}px;top:${y}px;width:156px;height:140px;text-align:center;padding-top:26px">
        <div style="display:flex;justify-content:center;color:#94a3b8">${ic("chip", 44)}</div>
        <div style="font-size:16px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);font-weight:700;margin-top:14px">provider</div></div>`));
    const target = provs[4];
    const work = add(target, `<div class="abs" style="left:20px;right:20px;bottom:14px;height:4px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden"><i style="display:block;height:100%;width:0;background:var(--main)"></i></div>`);
    const q = add(root, `<div class="abs" style="left:1068px;top:768px;width:630px;text-align:center"><span class="pill" style="font-size:22px;padding:12px 22px;background:rgba(251,191,36,.12);color:var(--ver);border:1px solid rgba(251,191,36,.3)">${ic("alert", 22)} Did it run the model… or make the labels up?</span></div>`);
    const pk1 = add(root, `<div class="pk" style="--c:var(--client)"><div class="dotp"></div><div class="lab">200 photos + payment</div></div>`);
    const pk2 = add(root, `<div class="pk" style="--c:var(--main)"><div class="dotp"></div><div class="lab">200 labels</div></div>`);
    const fly = (el, t, t0, d, a, b, bend) => {
      if (t < t0 - 0.05 || t > t0 + d + 0.4) { el.style.visibility = "hidden"; return; }
      const p = E.inOut(clamp((t - t0) / d));
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2 + bend;
      el.style.visibility = "visible";
      el.style.opacity = P(t, t0 - 0.05, 0.2) * (1 - P(t, t0 + d, 0.4));
      el.style.transform = `translate(${(1 - p) ** 2 * a[0] + 2 * (1 - p) * p * cx + p * p * b[0]}px,${(1 - p) ** 2 * a[1] + 2 * (1 - p) * p * cy + p * p * b[1]}px)`;
    };
    return (t) => {
      hd(t);
      show(l2, t, 1.7, Infinity, { dy: 20, blur: 8 });
      show(team, t, 1.0);
      provs.forEach((p, i) => show(p, t, 1.3 + i * 0.08));
      fly(pk1, t, 3.3, 1.3, [532, 590], [1352, 660], -90);
      work.firstElementChild.style.width = clamp((t - 4.7) / 1.4) * 100 + "%";
      target.style.boxShadow = t > 4.5 ? `0 0 0 1.5px var(--main), 0 0 40px rgba(96,165,250,${0.25 * P(t, 4.5, 0.5)})` : "";
      fly(pk2, t, 6.2, 1.3, [1352, 660], [532, 610], 90);
      show(got, t, 7.4, Infinity, { dy: 8 });
      show(q, t, 7.6, Infinity, { dy: 12, s0: 0.96 });
    };
  },
});

// ================================================================ 2. what DeGPU does
scene({
  id: "what", dur: 13, chapter: 0,
  build(root) {
    const hd = header(root, "What DeGPU does", "A compute marketplace where the rules are code", null, "var(--client)");
    const items = [
      ["cube", "var(--chain)", "Money on-chain", "Client deposits and provider stakes sit in smart contracts. Payouts and slashes are automatic.", "ProviderRegistry · JobMarket"],
      ["chip", "var(--main)", "Compute off-chain", "Providers run batch ML inference on their own machines: a batch of photos, one ImageNet model.", "ONNX Runtime · MobileNetV2"],
      ["shield", "var(--ver)", "Checked by random peers", "Some jobs are secretly re-run by randomly drawn providers. Cheaters lose their stake.", "commit → reveal → compare"],
    ];
    const cards = items.map(([icon, c, t, d, chip], i) => add(root, `<div class="card feat abs" style="left:${120 + i * 580}px;top:320px">
        <div class="iconbox" style="--c:${c}">${ic(icon, 34)}</div><div class="t">${t}</div><div class="d">${d}</div><span class="chipm mono">${chip}</span></div>`));
    return (t) => {
      hd(t);
      cards.forEach((c, i) => {
        show(c, t, 1.1 + i * 0.45, Infinity, { dy: 30, blur: 8 });
        const k = Math.max(0, 1 - Math.abs(t - (5.4 + i * 1.7)) / 1.1);
        c.style.boxShadow = `0 24px 60px -20px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.07), 0 0 0 ${1.5 * k}px rgba(255,255,255,${0.25 * k}), 0 0 ${60 * k}px rgba(167,139,250,${0.18 * k})`;
      });
    };
  },
});

// ================================================================ 3. architecture
scene({
  id: "arch", dur: 17, chapter: 0,
  build(root) {
    const hd = header(root, "Architecture", "Four moving parts", null, "var(--chain)");
    const chips = add(root, `<div class="abs" style="left:121px;top:216px;display:flex;gap:12px">${["Solidity · Foundry", "Python 3.12 · web3.py", "ONNX Runtime", "PyNaCl encryption"].map((s) => `<span class="chipm">${s}</span>`).join("")}</div>`);
    const panel = add(root, `<div class="chainpanel abs" style="left:380px;top:296px;width:1160px;height:214px"><div class="lb">Ethereum · local anvil chain</div></div>`);
    const card = (x, y, w, hgt, icon, c, title, file, desc) => add(root, `<div class="card arch abs" style="left:${x}px;top:${y}px;width:${w}px;height:${hgt}px">
        <div class="t">${ic(icon, 30, c)}${title}</div>${file ? `<div class="f mono">${file}</div>` : ""}<div class="d">${desc}</div></div>`);
    const reg = card(420, 328, 480, 150, "cube", "var(--chain)", "ProviderRegistry", "", "stake · encryption key · price · reputation<br>locked and slashed only by the market");
    const mkt = card(1020, 328, 480, 150, "cube", "var(--chain)", "JobMarket", "", "job states · escrow · hidden decision<br>random draws · comparison · settlement");
    const cli = card(200, 650, 440, 200, "laptop", "var(--client)", "Client", "degpu/client.py", "Encrypts inputs, posts jobs, reveals the decision, decodes results.");
    const sto = card(740, 650, 440, 200, "db", "#94a3b8", "Storage", "degpu/storage.py", "Content-addressed, encrypted blobs. Stands in for IPFS.");
    const pro = card(1280, 650, 440, 200, "chip", "var(--main)", "Providers A–F", "degpu/agent.py", "Main, verifier or tie-breaker. Run the ONNX model on CPU.");
    const svg = add(root, `<svg class="abs" style="left:0;top:0" width="1920" height="1080" viewBox="0 0 1920 1080" fill="none">
        <defs><linearGradient id="ag" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs></svg>`);
    const defs = [
      ["M420 650 C420 575 1120 600 1120 478", "url(#ag)", 4.2],
      ["M1500 650 C1500 590 1380 590 1380 478", "#60a5fa", 4.5],
      ["M640 750 L740 750", "#5eead4", 4.8],
      ["M1180 750 L1280 750", "#94a3b8", 5.0],
      ["M900 403 L1020 403", "#a78bfa", 3.6],
    ];
    const paths = defs.map(([d, stroke, t0]) => {
      const base = h(`<svg><path d="${d}" stroke="rgba(255,255,255,.12)" stroke-width="2" stroke-dasharray="3 7"/></svg>`).firstElementChild;
      const p = h(`<svg><path d="${d}" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/></svg>`).firstElementChild;
      svg.appendChild(base);
      svg.appendChild(p);
      const len = p.getTotalLength();
      p.style.strokeDasharray = len;
      const dots = [0, 1].map(() => { const c = h(`<svg><circle r="5" data-amb="1" fill="${stroke.startsWith("url") ? "#a5f3fc" : stroke}"/></svg>`).firstElementChild; svg.appendChild(c); return c; });
      return { p, base, len, t0, dots };
    });
    const labels = [
      [560, 538, "createJob · reveal · share keys", 5.4],
      [1462, 566, "accept · commit · check · publish", 5.6],
      [652, 712, "upload", 5.8],
      [1186, 712, "fetch", 5.9],
    ].map(([x, y, s, t0]) => [add(root, `<div class="abs mono" style="left:${x}px;top:${y}px;font-size:15px;color:var(--muted);white-space:nowrap">${s}</div>`), t0]);
    return (t, tau) => {
      hd(t);
      show(chips, t, 0.8);
      show(panel, t, 1.0, Infinity, { dy: 10 });
      show(reg, t, 1.4); show(mkt, t, 1.7);
      show(cli, t, 2.5); show(sto, t, 2.9); show(pro, t, 3.3);
      paths.forEach(({ p, base, len, t0, dots }, k) => {
        const pr = P(t, t0, 1.0, E.inOut);
        p.style.strokeDashoffset = len * (1 - pr);
        base.style.opacity = P(t, t0 - 0.6, 0.6);
        dots.forEach((c, j) => {
          const period = 2.6 + k * 0.3;
          const ph = (((tau - t0 - 1 + j * period / 2) / period) % 1 + 1) % 1;
          const on = t > t0 + 1;
          const pt = p.getPointAtLength(len * (k === 1 || k === 4 ? (j ? ph : 1 - ph) : ph));
          c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y);
          c.style.opacity = on ? P(t, t0 + 1, 0.5) * Math.sin(Math.PI * ph) : 0;
        });
      });
      labels.forEach(([el, t0]) => show(el, t, t0, Infinity, { dy: 6 }));
    };
  },
});

// ================================================================ 4. the hidden decision
scene({
  id: "hidden", dur: 23, chapter: 1,
  build(root) {
    const c1 = D.verifyCommits[1], c2 = D.verifyCommits[2];
    const hd = header(root, "The key idea", "A secret decision: check this job, or not?", null, "var(--ver)");
    const cl = add(root, `<div class="card abs" style="left:120px;top:300px;width:600px;height:540px;padding:30px 36px">
        <div style="display:flex;align-items:center;gap:16px"><div class="av" style="--c:var(--client)">${ic("laptop", 28, "#0b1020")}</div><div style="font-size:28px;font-weight:700">Client posts a job</div></div>
        <div style="font-size:24px;color:var(--muted);margin-top:34px">Verify this job?</div></div>`);
    const sw = add(cl, `<div class="switch abs" style="left:36px;top:162px"><div class="knob"></div></div>`);
    const val = add(cl, `<div class="abs" style="left:192px;top:172px;font-size:34px;font-weight:750">no</div>`);
    const lock = add(cl, `<div class="abs" style="left:28px;top:150px;width:300px;height:90px;display:flex;align-items:center"><span class="pill" style="font-size:22px;padding:12px 20px;background:rgba(255,255,255,.1);color:#fff">${ic("lock", 22)} kept secret</span></div>`);
    const f1 = add(cl, `<div class="abs mono" style="left:36px;top:292px;font-size:21px;line-height:1.7;color:#c6cee0">
        <span class="c-chain">verifyCommit</span> = keccak256(salt, verify)<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= <span class="c-chain">${c1}…</span></div>`);
    const f2 = add(cl, `<div class="abs" style="left:36px;right:36px;top:410px;border-top:1px solid rgba(255,255,255,.08);padding-top:20px;display:flex;justify-content:space-between;font-size:23px">
        <span class="c-muted">Deposit</span><span><span class="mono">2 × price</span> = <b class="mono">0.040 ETH</b></span></div>`);
    const f3 = add(cl, `<div class="abs" style="left:36px;right:36px;top:470px;font-size:19px;color:var(--dim)">The same, whatever the answer.</div>`);
    const lab = add(root, `<div class="tag abs" style="left:802px;top:298px;--c:var(--chain)"><span class="dot"></span>What the chain shows · anyone can read it</div>`);
    const job = (x, n, commit) => add(root, `<div class="card jobcard abs" style="left:${x}px;top:350px">
        <div class="hd">Job #${n}<span class="pill" style="font-size:14px;background:rgba(167,139,250,.14);color:var(--chain)">ON-CHAIN</span></div>
        <div class="jrow"><span class="k">Main provider</span><span class="v">A</span></div>
        <div class="jrow"><span class="k">Items</span><span class="v">200</span></div>
        <div class="jrow"><span class="k">Deposit</span><span class="v mono">0.040 ETH</span></div>
        <div class="jrow"><span class="k">verifyCommit</span><span class="v mono c-chain">${commit}…</span></div>
        <div class="reveal" style="background:rgba(255,255,255,.05)">
          <div class="abs r0" style="inset:0;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--muted)">${ic("lock", 22)} decision hidden</div>
          <div class="abs r1" style="inset:0;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--main)">${ic("check", 22)} A committed its results</div>
          <div class="abs r2" style="inset:0;display:flex;align-items:center;justify-content:center;gap:10px"></div></div></div>`);
    const j1 = job(800, 1, c1), j2 = job(1330, 2, c2);
    j1.querySelector(".r2").innerHTML = `${ic("unlock", 22)} revealed: no · A paid, no check`;
    j1.querySelector(".r2").style.cssText += ";color:#cbd5e1;background:rgba(148,163,184,.14)";
    j2.querySelector(".r2").innerHTML = `${ic("unlock", 22)} revealed: yes · 2 verifiers drawn`;
    j2.querySelector(".r2").style.cssText += ";color:var(--ver);background:rgba(251,191,36,.14)";
    const rowsY = [...j1.querySelectorAll(".jrow")].map((r) => 350 + r.offsetTop + r.offsetHeight / 2);
    const marks = rowsY.map((y, i) => add(root, `<div class="abs" style="left:1283px;top:${y - 17}px;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;${i < 3 ? "background:rgba(74,222,128,.16);color:var(--ok)" : "background:rgba(255,255,255,.08);color:var(--muted)"}">${i < 3 ? "=" : "?"}</div>`));
    const flips = [[1.2, 1], [1.75, 0], [2.3, 1], [2.85, 0], [3.35, 1]];
    const setRev = (j, t, t1, t2) => {
      j.querySelector(".r0").style.opacity = 1 - P(t, t1, 0.4);
      const r1 = j.querySelector(".r1");
      r1.style.opacity = P(t, t1, 0.4) * (1 - P(t, t2, 0.35));
      const r2 = j.querySelector(".r2");
      const p = P(t, t2, 0.6, E.outBack);
      r2.style.opacity = P(t, t2, 0.3);
      r2.style.transform = `perspective(400px) rotateX(${(1 - p) * 80}deg)`;
    };
    return (t) => {
      hd(t);
      show(cl, t, 0.9, Infinity, { dy: 24 });
      let pos = 0, last = [-1, 0];
      for (const f of flips) if (t >= f[0]) last = f;
      const prevOn = flips.indexOf(last) > 0 ? flips[flips.indexOf(last) - 1][1] : 0;
      pos = last[0] < 0 ? 0 : lerp(prevOn, last[1], P(t, last[0], 0.25, E.inOut));
      sw.firstElementChild.style.left = 6 + pos * 66 + "px";
      sw.style.background = `rgba(${Math.round(lerp(255, 251, pos))},${Math.round(lerp(255, 191, pos))},${Math.round(lerp(255, 36, pos))},${lerp(0.1, 0.55, pos)})`;
      val.textContent = pos > 0.5 ? "yes" : "no";
      val.style.color = pos > 0.5 ? "var(--ver)" : "var(--text)";
      const hid = P(t, 3.9, 0.7);
      const blur = hid * 10;
      sw.style.filter = blur > 0.05 ? `blur(${blur}px)` : "none";
      val.style.filter = sw.style.filter;
      sw.style.opacity = val.style.opacity = 1 - hid * 0.75;
      pop(lock, t, 4.0);
      show(f1, t, 4.6, Infinity, { dy: 10 });
      show(f2, t, 5.2, Infinity, { dy: 10 });
      show(f3, t, 5.6, Infinity, { dy: 6 });
      show(lab, t, 6.0);
      show(j1, t, 6.3, Infinity, { dy: 26 });
      show(j2, t, 6.8, Infinity, { dy: 26 });
      marks.forEach((m, i) => pop(m, t, 8.4 + i * 0.4));
      setRev(j1, t, 14.8, 17.0);
      setRev(j2, t, 14.95, 17.6);
    };
  },
});

// ================================================================ 5. life of a job
scene({
  id: "flow", dur: 27, chapter: 1,
  build(root) {
    const hd = header(root, "How a job runs", "Life of a job", null, "var(--main)");
    const N = {
      open: [110, 420, "Open", 1], acc: [350, 420, "Accepted", 2], com: [590, 420, "Committed", 3], rev: [830, 420, "Revealed", 4],
      pub: [1090, 300, "Publish & pay", 5], del: [1340, 300, "Delivered", "✓"],
      chk: [1090, 540, "Checking", 6], cmp: [1340, 540, "Compare", 7], ver: [1590, 470, "Verified", 8], tie: [1590, 610, "Tie-break", 9],
    };
    const svg = add(root, `<svg class="abs" style="left:0;top:0" width="1920" height="1080" fill="none"></svg>`);
    const edgeDefs = [["open", "acc"], ["acc", "com"], ["com", "rev"], ["rev", "pub", "no"], ["pub", "del"], ["rev", "chk", "yes"], ["chk", "cmp"], ["cmp", "ver"], ["cmp", "tie"]];
    const edges = {};
    for (const [a, b, label] of edgeDefs) {
      const [x1, y1] = [N[a][0] + 196, N[a][1] + 31], [x2, y2] = [N[b][0], N[b][1] + 31];
      const dx = (x2 - x1) / 2;
      const d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
      const base = h(`<svg><path d="${d}" stroke="rgba(255,255,255,.16)" stroke-width="2" stroke-dasharray="3 6"/></svg>`).firstElementChild;
      const lit = h(`<svg><path d="${d}" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>`).firstElementChild;
      svg.appendChild(base); svg.appendChild(lit);
      const len = lit.getTotalLength();
      lit.style.strokeDasharray = len;
      let lab = null;
      if (label) {
        const mid = lit.getPointAtLength(len / 2);
        lab = add(root, `<div class="flabel abs" style="left:${mid.x - 140}px;top:${mid.y - 10}px;width:120px;text-align:right;color:${label === "no" ? "#cbd5e1" : label === "yes" ? "var(--ver)" : label === "mismatch" ? "var(--bad)" : "var(--ok)"}">${label}</div>`);
      }
      edges[a + ">" + b] = { base, lit, len, lab };
    }
    const nodes = {};
    for (const [k, [x, y, label, n]] of Object.entries(N)) nodes[k] = add(root, `<div class="fnode abs" style="left:${x}px;top:${y}px"><span class="n">${n}</span>${label}</div>`);
    const ACT = { client: ["Client", "var(--client)", "laptop"], main: ["Main provider", "var(--main)", "chip"], contract: ["Contract", "var(--chain)", "cube"], ver: ["2 verifiers", "var(--ver)", "shield"], tb: ["Tie-breaker", "var(--tb)", "scale"] };
    const STEPS = [
      [["open"], [], "client", "Posts 200 encrypted photos and the model, deposits <b>2 × price</b>, and a hash of its <b>secret</b> decision."],
      [["acc"], ["open>acc"], "main", "Checks that the inputs match the job’s <b>dataHash</b>, accepts, and runs the model."],
      [["com"], ["acc>com"], "main", "Commits to a hash of all 200 results <b>before</b> knowing whether the job will be checked."],
      [["rev"], ["com>rev"], "client", "Reveals the decision. The contract checks it against the hash from step 1."],
      [["pub", "del"], ["rev>pub", "pub>del"], "contract", "<b>“No”:</b> the main provider publishes and is paid. The client gets the unused half of its deposit back."],
      [["chk"], ["rev>chk"], "ver", "<b>“Yes”:</b> two random verifiers each re-run half of the items. Both commit, then reveal, so nobody can copy."],
      [["cmp"], ["chk>cmp"], "contract", "The main provider publishes all its results, and the contract compares <b>every item</b>, hash against hash."],
      [["ver"], ["cmp>ver"], "contract", "<b>All match:</b> the main provider and both verifiers are paid."],
      [["tie"], ["cmp>tie"], "tb", "<b>Mismatch:</b> a random tie-breaker re-runs just those items. The majority wins; the outvoted party is slashed."],
    ];
    const ST0 = 1.9, STEP = 2.62;
    const desc = add(root, `<div class="card fdesc abs"></div>`);
    const rows = STEPS.map(([, , who, txt], i) => {
      const [name, c, icon] = ACT[who];
      return add(desc, `<div class="row"><div class="num" style="color:${c}">${i + 1}</div>
        <div class="who"><span class="pill" style="font-size:18px;padding:9px 16px;background:color-mix(in srgb, ${c} 15%, transparent);color:${c}">${ic(icon, 20)} ${name}</span></div>
        <div class="txt">${txt}</div></div>`);
    });
    const stepOf = {};
    STEPS.forEach(([ns, es, who], i) => { ns.forEach((n) => (stepOf[n] = [i, ACT[who][1]])); es.forEach((e) => (stepOf[e] = [i, ACT[who][1]])); });
    return (t) => {
      hd(t);
      const cur = Math.floor((t - ST0) / STEP);
      Object.entries(nodes).forEach(([k, el], j) => {
        show(el, t, 0.8 + j * 0.06, Infinity, { dy: 10, blur: 4 });
        const [i, c] = stepOf[k];
        const ts = ST0 + i * STEP + 0.35;
        const on = P(t, ts, 0.4);
        const active = cur === i;
        const faded = (k === "pub" || k === "del") && cur >= 5;
        el.style.borderColor = on > 0 ? (active ? c : "rgba(255,255,255,.32)") : "rgba(255,255,255,.14)";
        el.style.color = on > 0 ? (active ? "#fff" : "#cbd5e1") : "var(--dim)";
        el.style.background = active ? `color-mix(in srgb, ${c} ${Math.round(18 * on)}%, transparent)` : on > 0 ? "rgba(255,255,255,.05)" : "rgba(255,255,255,.02)";
        el.style.boxShadow = active ? `0 0 ${36 * on}px color-mix(in srgb, ${c} 45%, transparent)` : "none";
        const n = el.firstElementChild;
        n.style.background = on > 0 ? c : "rgba(255,255,255,.08)";
        n.style.color = on > 0 ? "#0b1020" : "var(--dim)";
        if (faded) el.style.opacity = Number(el.style.opacity) * lerp(1, 0.5, P(t, ST0 + 5 * STEP, 0.6));
        if (active) el.style.transform += ` scale(${lerp(1, 1.05, on)})`;
      });
      Object.entries(edges).forEach(([k, { base, lit, len, lab }]) => {
        const [i, c] = stepOf[k];
        const ts = ST0 + i * STEP - 0.15;
        base.style.opacity = P(t, 1.0, 0.8);
        lit.style.stroke = c.startsWith("var") ? getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)) : c;
        lit.style.strokeDashoffset = len * (1 - P(t, ts, 0.55, E.inOut));
        let o = P(t, ts, 0.2);
        if ((k === "rev>pub" || k === "pub>del") && cur >= 5) o *= lerp(1, 0.4, P(t, ST0 + 5 * STEP, 0.6));
        lit.style.opacity = o;
        if (lab) show(lab, t, ts + 0.3, Infinity, { dy: 6 });
      });
      show(desc, t, 1.3, Infinity, { dy: 20 });
      rows.forEach((r, i) => {
        const ts = ST0 + i * STEP;
        const pin = P(t, ts, 0.5), pout = i < rows.length - 1 ? P(t, ts + STEP - 0.25, 0.3) : 0;
        r.style.opacity = pin * (1 - pout);
        r.style.transform = `translateY(${(1 - pin) * 16 - pout * 10}px)`;
      });
    };
  },
});

// ================================================================ 6. privacy
scene({
  id: "privacy", dur: 14, chapter: 1,
  build(root) {
    const hd = header(root, "Privacy", "Each party sees only what it needs", null, "var(--client)");
    const mism = new Set(D.jobs["3"].mismatched);
    const cols = [
      ["Main provider", "var(--main)", "chip", () => true, "200 items", "Gets the job key, sealed to its own X25519 key."],
      ["Verifier 1", "var(--ver)", "shield", (i) => i < 100, "100 items", "Only the keys for items 0–99."],
      ["Verifier 2", "var(--ver)", "shield", (i) => i >= 100, "100 items", "Only the keys for items <span style='white-space:nowrap'>100–199</span>."],
      ["Tie-breaker", "var(--tb)", "scale", (i) => mism.has(i), `${mism.size} items`, "Only the items that mismatched (scenario 3)."],
      ["Blockchain", "var(--chain)", "cube", () => false, "0 photos", "Only hashes, salted result leaves and sealed keys."],
    ];
    const cards = cols.map(([title, c, icon, sel, big, d], k) => {
      const el = add(root, `<div class="card pcol abs" style="left:${120 + k * 340}px;top:300px">
          <div class="t"><span class="iconbox" style="--c:${c};width:44px;height:44px;border-radius:13px">${ic(icon, 24)}</span>${title}</div>
          <div class="mgrid"></div><div class="big" style="color:${c}">${big}</div><div class="d">${d}</div></div>`);
      const g = el.querySelector(".mgrid");
      const cells = Array.from({ length: 200 }, (_, i) => [add(g, "<i></i>"), sel(i)]);
      return { el, cells, c, k };
    });
    return (t) => {
      hd(t);
      cards.forEach(({ el, cells, c, k }) => {
        show(el, t, 0.9 + k * 0.22, Infinity, { dy: 28 });
        const t0 = 1.9 + k * 0.45;
        cells.forEach(([cell, on], i) => {
          const p = P(t, t0 + ((i % 20) + Math.floor(i / 20)) * 0.025, 0.3);
          cell.style.background = on && p > 0 ? `color-mix(in srgb, ${c} ${Math.round(85 * p)}%, rgba(255,255,255,.08))` : "rgba(255,255,255,.08)";
        });
      });
    };
  },
});

// ================================================================ 7. demo intro
scene({
  id: "demo", dur: 10, chapter: 2,
  build(root) {
    const hd = header(root, "Live demo", "Five scenarios, one real run", "<span class='mono' style='color:var(--client)'>uv run scripts/demo.py</span> &nbsp;·&nbsp; a fresh local chain &nbsp;·&nbsp; real ONNX inference", "var(--ok)");
    const sc = [
      ["Unverified job", "Secret “no”: main A is paid, nothing is re-run."],
      ["Verified job", "Secret “yes”: two verifiers re-run all 200 items."],
      ["Cheater caught", "Main E fakes 20% of its labels."],
      ["Lying verifiers", "The checkers lie; a tie-breaker settles it."],
      ["Provider offline", "Main F goes silent and misses its deadline."],
    ].map(([t, d], k) => add(root, `<div class="card abs" style="left:${120 + k * 340}px;top:352px;width:316px;height:236px;padding:28px">
        <div class="grad" style="font-size:54px;font-weight:800;line-height:1">${k + 1}</div>
        <div style="font-size:27px;font-weight:700;margin-top:18px">${t}</div>
        <div style="font-size:20px;color:var(--muted);margin-top:8px;line-height:1.4">${d}</div></div>`));
    const setup = add(root, `<div class="card abs" style="left:120px;top:630px;width:1676px;height:118px;padding:0 34px;display:flex;align-items:center;gap:16px">
        <span style="font-size:17px;font-weight:700;letter-spacing:.16em;color:var(--dim);margin-right:8px">SETUP</span>
        ${["6 providers, A–F", "1 ETH stake each", "0.0001 ETH per item", "200 photos = 0.020 ETH", "deposit 2 × price = 0.040 ETH", "MobileNetV2 · ONNX"].map((s) => `<span class="chipm" style="font-size:19px">${s}</span>`).join("")}</div>`);
    return (t) => {
      hd(t);
      sc.forEach((c, k) => show(c, t, 1.0 + k * 0.22, Infinity, { dy: 28 }));
      show(setup, t, 2.4, Infinity, { dy: 16 });
    };
  },
});

// ================================================================ scenarios
function photoStrip(root, t0, t1, runStart, runDur) {
  const strip = add(root, `<div class="abs strip" style="left:137px;top:452px;display:flex;gap:40px"></div>`);
  const items = PICKS.map((i, k) => {
    const el = add(strip, `<div><div class="th"><img src="${imgSrc(i)}"></div><div class="lab">${className(D.expected[i])}</div></div>`);
    return { el, img: el.querySelector(".th"), lab: el.querySelector(".lab"), k };
  });
  return (t) => {
    const out = P(t, t1, 0.5, E.inOut);
    strip.style.visibility = t < t0 - 0.1 || out >= 1 ? "hidden" : "visible";
    items.forEach(({ img, lab, k }) => {
      show(img, t, t0 + k * 0.09, Infinity, { dy: 14, s0: 0.9 });
      img.parentElement.style.opacity = 1 - out;
      const lt = runStart + (k + 1) * (runDur / (PICKS.length + 1));
      show(lab, t, lt, Infinity, { dy: 6, d: 0.4 });
    });
  };
}

function compareGrid(root, t0, t1, text, color, badSet) {
  const box = add(root, `<div class="abs" style="left:430px;top:452px;width:700px;height:150px"></div>`);
  const g = miniGrid(box, 0, 0, 11, 3);
  const lab = add(box, `<div class="abs" style="left:312px;top:30px"><div style="font-size:44px;font-weight:780;color:${color}" class="tnum cnt"></div><div style="font-size:19px;color:var(--muted);margin-top:4px">${text}</div></div>`);
  const cnt = lab.querySelector(".cnt");
  const n = badSet ? badSet.size : 200;
  return (t) => {
    const o = show(box, t, t0, t1, { dy: 10 });
    if (o <= 0) return;
    let k = 0;
    g.cells.forEach((c, i) => {
      const ts = t0 + 0.3 + ((i % 20) + Math.floor(i / 20)) * 0.035;
      const on = t >= ts;
      const bad = badSet ? badSet.has(i) : color === "var(--bad)";
      if (on && (bad || !badSet)) k++;
      c.style.background = on ? (bad ? "var(--bad)" : "var(--ok)") : "rgba(255,255,255,.08)";
      c.style.opacity = on ? 0.9 : 1;
    });
    cnt.textContent = `${Math.min(k, n)} / 200`;
  };
}

// ---------------------------------------------------------------- scenario 1
scene({
  id: "s1", dur: 17, chapter: 2,
  build(root, cue) {
    const sc = D.scenarios[1];
    const hd = header(root, "Scenario 1 / 5", "An unverified job", "Main provider <b>A</b> &nbsp;·&nbsp; secret decision: <b>no</b> &nbsp;·&nbsp; everyone honest", "var(--main)");
    const S = Stage(root, { job: 1, timeline: sc.timeline });
    S.nodesIn(0.8);
    S.post(2.0, "no", commitOf(sc), 0);
    S.offer(3.2, "A");
    S.accept(4.2, "A", 1, 2.3);
    const strip = photoStrip(root, 4.3, 6.9, 4.2, 2.3);
    S.commit(7.0, "A", 2);
    S.reveal(8.3, false, 3);
    S.publish(9.6, "A", 4);
    S.pay(10.6, "A", 0.02, 5);
    S.toClient(11.0, 0.02, 6);
    S.close(12.4, 7, "DELIVERED", "var(--ok)", "check", cue);
    S.finish();
    return (t) => { hd(t); S.update(t); strip(t); };
  },
});

// ---------------------------------------------------------------- scenario 2
scene({
  id: "s2", dur: 24, chapter: 2,
  build(root, cue) {
    const sc = D.scenarios[2];
    const [v0, v1] = D.jobs["2"].verifiers;
    const hd = header(root, "Scenario 2 / 5", "A verified job", `Main provider <b>A</b> &nbsp;·&nbsp; secret decision: <b>yes</b> &nbsp;·&nbsp; everyone honest`, "var(--ver)");
    const S = Stage(root, { job: 2, timeline: sc.timeline });
    S.nodesIn(0.8);
    S.post(1.8, "yes", commitOf(sc), 0);
    S.offer(2.7, "A");
    S.accept(3.5, "A", 1, 1.4);
    S.commit(5.0, "A", 2);
    S.reveal(6.2, true, 3);
    const others = NAMES.filter((n) => n !== "A");
    S.draw(7.1, others, [v0, v1], [ROLE.v0, ROLE.v1], 1.5);
    S.tl(8.7, 4);
    S.packet(9.2, 0.9, ANCH.clientB, ANCH.prov(v0), "var(--client)", "keys 0–99");
    S.packet(9.5, 0.9, ANCH.clientB, ANCH.prov(v1), "var(--client)", "keys 100–199");
    S.tl(9.9, 5, 6);
    S.status(10.1, v0, "re-running 0–99", "var(--ver)", 1.6);
    S.status(10.4, v1, "re-running 100–199", "var(--ver)", 1.6);
    S.packet(12.1, 0.75, ANCH.prov(v0), ANCH.marketB, "var(--ver)", "check hash");
    S.packet(12.3, 0.75, ANCH.prov(v1), ANCH.marketB, "var(--ver)");
    S.status(12.2, v0, "check committed", "var(--text)");
    S.status(12.4, v1, "check committed", "var(--text)");
    S.tl(12.8, 7, 8);
    S.market(12.8, "CHECK REVEAL");
    S.packet(13.7, 0.75, ANCH.prov(v1), ANCH.marketB, "var(--ver)", "100 leaves");
    S.packet(13.9, 0.75, ANCH.prov(v0), ANCH.marketB, "var(--ver)");
    S.status(14.3, v0, "check revealed", "var(--text)");
    S.status(14.3, v1, "check revealed", "var(--text)");
    S.tl(14.4, 9, 10);
    S.market(14.9, "PUBLISHING");
    S.publish(15.3, "A", 11);
    S.market(16.0, "COMPARING");
    const cmp = compareGrid(root, 16.1, 18.3, "items match", "var(--ok)");
    S.pay(18.4, "A", 0.02, 12);
    S.pay(18.6, v0, 0.01, 13);
    S.pay(18.8, v1, 0.01, 14);
    S.close(19.7, 15, "VERIFIED", "var(--ok)", "shield", cue);
    S.finish();
    return (t) => { hd(t); S.update(t); cmp(t); };
  },
});

// ---------------------------------------------------------------- scenario 3
scene({
  id: "s3", dur: 33, chapter: 2,
  build(root, cue) {
    const sc = D.scenarios[3];
    const job = D.jobs["3"];
    const [v0, v1] = job.verifiers, tb = job.tiebreaker, M = job.main;
    const faked = new Set(job.agents[M].cheated);
    const hd = header(root, "Scenario 3 / 5", "A cheater gets caught", `Main provider <b>${M}</b> fakes 20% of its labels &nbsp;·&nbsp; secret decision: <b>yes</b>`, "var(--bad)");
    const S = Stage(root, { job: 3, timeline: sc.timeline, tags: { [M]: "cheats" } });
    S.nodesIn(0.8);
    S.post(1.8, "yes", commitOf(sc), 0);
    S.offer(2.6, M);
    S.accept(3.4, M, 1, 1.3);
    S.status(4.75, M, `faked ${faked.size} labels`, "var(--bad)");
    S.commit(5.2, M, 2, `faked ${faked.size} · committed`);
    S.status(5.4, M, `faked ${faked.size} · committed`, "var(--bad)");
    S.reveal(6.3, true, 3);
    S.draw(7.1, NAMES.filter((n) => n !== M), [v0, v1], [ROLE.v0, ROLE.v1], 1.4);
    S.tl(8.6, 4);
    S.packet(9.0, 0.9, ANCH.clientB, ANCH.prov(v0), "var(--client)", "keys 0–99");
    S.packet(9.2, 0.9, ANCH.clientB, ANCH.prov(v1), "var(--client)", "keys 100–199");
    S.tl(9.7, 5, 6);
    S.status(9.9, v0, "re-running 0–99", "var(--ver)", 1.4);
    S.status(10.1, v1, "re-running 100–199", "var(--ver)", 1.4);
    S.packet(11.6, 0.7, ANCH.prov(v0), ANCH.marketB, "var(--ver)", "check hash");
    S.packet(11.8, 0.7, ANCH.prov(v1), ANCH.marketB, "var(--ver)");
    S.status(11.8, v0, "check committed", "var(--text)");
    S.status(12.0, v1, "check committed", "var(--text)");
    S.tl(12.2, 7, 8);
    S.packet(12.8, 0.7, ANCH.prov(v1), ANCH.marketB, "var(--ver)", "100 leaves");
    S.packet(13.0, 0.7, ANCH.prov(v0), ANCH.marketB, "var(--ver)");
    S.status(13.3, v0, "check revealed", "var(--text)");
    S.status(13.3, v1, "check revealed", "var(--text)");
    S.tl(13.4, 9, 10);
    S.market(13.8, "PUBLISHING");
    S.publish(14.0, M, 11);
    S.market(14.7, "COMPARING");

    // ---- the 200 photos, compared item by item
    const OV0 = 15.0, SCAN = 16.4, SCAN_D = 2.4, OV1 = 22.0;
    const ov = add(root, `<div class="card abs" style="left:110px;top:290px;width:1090px;height:574px;background:linear-gradient(180deg,#11162a,#0c1020)">
        <div class="abs" style="left:36px;top:24px;font-size:25px;font-weight:700">${M}’s 200 results vs. the verifiers’ re-runs</div>
        <div class="abs" style="right:34px;top:24px;display:flex;gap:10px"><span class="pill" style="background:rgba(251,191,36,.14);color:var(--ver)">${v0} · items 0–99</span><span class="pill" style="background:rgba(251,191,36,.14);color:var(--ver)">${v1} · items 100–199</span></div></div>`);
    const GL = 36, GT = 80, CS = 40, GS = 44;
    const grid = add(ov, `<div class="abs" style="left:${GL}px;top:${GT}px;width:${20 * GS}px;height:${10 * GS}px"></div>`);
    const cells = D.images.map((_, i) => {
      const r = Math.floor(i / 20), c = i % 20;
      const el = add(grid, `<div class="th abs" style="left:${c * GS}px;top:${r * GS + (r >= 5 ? 6 : 0)}px;width:${CS}px;height:${CS}px"><img src="${imgSrc(i)}"><div class="ov"></div></div>`);
      return { el, ov: el.lastElementChild, img: el.firstElementChild, bad: faked.has(i), ts: SCAN + ((i % 100) / 100) * SCAN_D, wave: OV0 + 0.25 + (c + r) * 0.03 };
    });
    const div = add(grid, `<div class="abs" style="left:-6px;right:-6px;top:${5 * GS + 1}px;height:2px;background:rgba(251,191,36,.35)"></div>`);
    const side = add(ov, `<div class="abs" style="left:${GL + 20 * GS + 24}px;top:${GT + 10}px;width:120px">
        <div class="k" style="font-size:14px;font-weight:700;letter-spacing:.14em;color:var(--dim)">MISMATCH</div>
        <div class="tnum mis" style="font-size:66px;font-weight:800;color:var(--bad);line-height:1.1">0</div>
        <div class="k" style="font-size:14px;font-weight:700;letter-spacing:.14em;color:var(--dim);margin-top:26px">MATCH</div>
        <div class="tnum mat" style="font-size:40px;font-weight:780;color:var(--ok)">0</div></div>`);
    const mis = side.querySelector(".mis"), mat = side.querySelector(".mat");
    // zoom on one faked item
    const zi = [...faked].find((i) => D.classNames[D.expected[i]] && i >= 20) ?? [...faked][0];
    const zr = Math.floor(zi / 20), zc = zi % 20;
    const zx = GL + zc * GS + CS / 2, zy = GT + zr * GS + CS / 2 + (zr >= 5 ? 6 : 0);
    const vOf = zi < 100 ? v0 : v1;
    const vLab = job.agents[vOf].labels[job.agents[vOf].indices.indexOf(zi)];
    const zoom = add(ov, `<div class="card abs" style="left:${zx - 200}px;top:${zy + 70}px;width:470px;height:236px;padding:22px;display:flex;gap:22px;background:rgba(20,26,44,.98)">
        <div class="th" style="width:150px;height:150px;border-radius:14px;flex:none"><img src="${imgSrc(zi)}"></div>
        <div style="flex:1"><div style="font-size:16px;color:var(--dim);font-weight:700;letter-spacing:.12em">ITEM #${zi}</div>
          <div style="margin-top:12px;font-size:15px;color:var(--muted)">${M} · main</div><div style="font-size:23px;font-weight:700;color:var(--bad);display:flex;align-items:center;gap:6px">${ic("x", 20)}${className(job.agents[M].labels[zi])}</div>
          <div style="margin-top:10px;font-size:15px;color:var(--muted)">${vOf} · verifier</div><div style="font-size:23px;font-weight:700;color:var(--ok);display:flex;align-items:center;gap:6px">${ic("check", 20)}${className(vLab)}</div></div>
        <div class="abs" style="left:22px;bottom:16px;font-size:17px;color:var(--muted)">Hashes differ → this item goes to the tie-breaker</div></div>`);
    const zline = add(ov, `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${zx} ${zy + 22} L${zx} ${zy + 70}" stroke="#fff" stroke-width="2" stroke-dasharray="3 4"/></svg>`);
    const zring = add(ov, `<div class="abs" style="left:${zx - 26}px;top:${zy - 26}px;width:52px;height:52px;border-radius:10px;border:3px solid #fff;box-shadow:0 0 24px rgba(255,255,255,.5)"></div>`);
    S.tl(18.9, 12);
    S.extra((t) => {
      const o = show(ov, t, OV0, OV1, { dy: 16, s0: 0.98, dout: 0.6 });
      if (o <= 0) return;
      show(div, t, SCAN - 0.4);
      const zt = 19.4;
      const dimz = P(t, zt, 0.5) * (1 - P(t, 21.4, 0.4));
      let nm = 0, nk = 0;
      cells.forEach((c, i) => {
        const pin = P(t, c.wave, 0.45);
        const scanned = t >= c.ts;
        if (scanned) c.bad ? nm++ : nk++;
        c.el.style.opacity = pin * (i === zi ? 1 : 1 - dimz * 0.7);
        c.el.style.transform = `scale(${lerp(0.7, 1, pin)})`;
        c.img.style.opacity = scanned ? (c.bad ? 1 : 0.42) : 0.62;
        const hot = Math.abs(t - c.ts) < 0.06;
        c.ov.style.boxShadow = scanned && c.bad ? "inset 0 0 0 3px var(--bad)" : hot ? "inset 0 0 0 2px #fff" : "none";
        c.ov.style.background = scanned && c.bad ? "rgba(248,113,113,.28)" : scanned ? "rgba(74,222,128,.10)" : "transparent";
      });
      mis.textContent = nm;
      mat.textContent = nk;
      pop(zring, t, zt);
      show(zline, t, zt + 0.15, Infinity, { dy: 0, blur: 0 });
      show(zoom, t, zt + 0.25, Infinity, { dy: 14 });
      zring.style.opacity = Number(zring.style.opacity) * (1 - P(t, 21.4, 0.4));
      zline.style.opacity = Number(zline.style.opacity) * (1 - P(t, 21.4, 0.4));
      zoom.style.opacity = Number(zoom.style.opacity) * (1 - P(t, 21.4, 0.4));
    });
    cue("tick", SCAN);

    S.draw(22.4, NAMES.filter((n) => ![M, v0, v1].includes(n)), [tb], [ROLE.tb], 1.0);
    S.packet(23.7, 0.9, ANCH.clientB, ANCH.prov(tb), "var(--client)", `keys of ${faked.size} items`);
    S.tl(24.3, 13);
    S.status(24.6, tb, `re-running ${faked.size} items`, "var(--tb)", 1.1);
    S.packet(25.8, 0.75, ANCH.prov(tb), ANCH.marketB, "var(--tb)", `${faked.size} leaves`);
    S.status(26.0, tb, "tie-break submitted", "var(--text)");
    S.tl(26.5, 14);
    S.slash(27.0, M, 0.3, 15, cue);
    S.escrow(27.2, 0.34);
    S.pay(27.9, v0, 0.01, 16);
    S.pay(28.1, v1, 0.01, 17);
    S.pay(28.3, tb, 0.002, 18);
    S.toClient(28.6, 0.318, 19);
    S.status(28.6, M, "suspended", "var(--bad)");
    S.dim(28.6, M, true);
    S.close(29.8, 20, "MAIN OUTVOTED", "var(--ok)", "shield", cue);
    S.finish();
    return (t) => { hd(t); S.update(t); };
  },
});

// ---------------------------------------------------------------- scenario 4
scene({
  id: "s4", dur: 26, chapter: 2,
  build(root, cue) {
    const sc = D.scenarios[4];
    const job = D.jobs["4"];
    const [v0, v1] = job.verifiers, tb = job.tiebreaker;
    const tags = {}, dim = {}, stakes = { E: 0.7 };
    NAMES.forEach((n) => { if (n !== "A") tags[n] = "lies"; });
    tags.E = "suspended"; dim.E = true;
    const hd = header(root, "Scenario 4 / 5", "Lying verifiers", "Main provider <b>A</b> is honest &nbsp;·&nbsp; every other provider <b>lies</b> as a verifier", "var(--tb)");
    const S = Stage(root, { job: 4, timeline: sc.timeline, tags, dim, stakes });
    S.nodesIn(0.8);
    S.post(1.8, "yes", commitOf(sc), 0);
    S.offer(2.5, "A");
    S.accept(3.2, "A", 1, 1.0);
    S.commit(4.3, "A", 2);
    S.reveal(5.3, true, 3);
    S.draw(6.0, NAMES.filter((n) => n !== "A" && n !== "E"), [v0, v1], [ROLE.v0, ROLE.v1], 1.3);
    S.tl(7.4, 4);
    S.packet(7.9, 0.85, ANCH.clientB, ANCH.prov(v0), "var(--client)", "keys 0–99");
    S.packet(8.1, 0.85, ANCH.clientB, ANCH.prov(v1), "var(--client)", "keys 100–199");
    S.tl(8.6, 5, 6);
    S.status(8.8, v0, "making up 100 labels", "var(--bad)", 1.2);
    S.status(9.0, v1, "making up 100 labels", "var(--bad)", 1.2);
    S.packet(10.3, 0.7, ANCH.prov(v1), ANCH.marketB, "var(--ver)", "check hash");
    S.packet(10.5, 0.7, ANCH.prov(v0), ANCH.marketB, "var(--ver)");
    S.status(10.6, v0, "check committed", "var(--text)");
    S.status(10.6, v1, "check committed", "var(--text)");
    S.tl(10.9, 7, 8);
    S.packet(11.4, 0.7, ANCH.prov(v0), ANCH.marketB, "var(--ver)", "100 leaves");
    S.packet(11.6, 0.7, ANCH.prov(v1), ANCH.marketB, "var(--ver)");
    S.tl(12.0, 9, 10);
    S.publish(12.4, "A", 11);
    S.market(13.1, "COMPARING");
    const cmp = compareGrid(root, 13.2, 15.6, "items mismatch", "var(--bad)");
    S.tl(14.2, 12);
    S.draw(15.7, NAMES.filter((n) => ![("A"), "E", v0, v1].includes(n)), [tb], [ROLE.tb], 0.9);
    S.packet(16.9, 0.85, ANCH.clientB, ANCH.prov(tb), "var(--client)", "keys of 200 items");
    S.tl(17.5, 13);
    S.status(17.7, tb, "re-running 200 items", "var(--tb)", 1.1);
    S.packet(18.9, 0.7, ANCH.prov(tb), ANCH.marketB, "var(--tb)", "200 leaves");
    S.status(19.1, tb, "tie-break submitted", "var(--text)");
    S.tl(19.5, 14);
    S.slash(20.0, v0, 0.3, 15, cue);
    S.slash(20.35, v1, 0.3, 16);
    S.escrow(20.4, 0.64);
    S.pay(21.0, "A", 0.02, 17);
    S.pay(21.2, tb, 0.002, 18);
    S.toClient(21.5, 0.618, 19);
    S.status(22.0, v0, "suspended", "var(--bad)");
    S.status(22.0, v1, "suspended", "var(--bad)");
    S.dim(22.0, v0, true);
    S.dim(22.0, v1, true);
    S.close(22.6, 20, "VERIFIERS OUTVOTED", "var(--ok)", "shield", cue);
    S.finish();
    return (t) => { hd(t); S.update(t); cmp(t); };
  },
});

// ---------------------------------------------------------------- scenario 5
scene({
  id: "s5", dur: 20, chapter: 2,
  build(root, cue) {
    const sc = D.scenarios[5];
    const hd = header(root, "Scenario 5 / 5", "A provider goes offline", "Main provider <b>F</b> accepts, then goes silent &nbsp;·&nbsp; secret decision: <b>no</b>", "var(--ver)");
    const S = Stage(root, { job: 5, timeline: sc.timeline, stakes: { B: 0.7, E: 0.7, F: 0.7 }, dim: { B: true, E: true }, tags: { B: "suspended", E: "suspended" } });
    S.nodesIn(0.8);
    S.stake(1.7, "F", 1.0, 1.0);
    S.float(1.8, [ANCH.prov("F")[0], 596], "+0.3 top-up", "var(--client)");
    S.status(1.8, "F", "stake topped up", "var(--client)");
    S.post(2.7, "no", commitOf(sc), 0);
    S.offer(3.5, "F");
    S.accept(4.3, "F", 1, 0, "accepted");
    S.status(5.1, "F", `${ic("moon", 14)} offline`, "#94a3b8");
    S.dim(5.3, "F", true);
    // deadline bar
    const dl = add(root, `<div class="abs" style="left:250px;top:458px;width:820px;height:140px">
        <div style="display:flex;align-items:center;gap:12px;font-size:21px;font-weight:650">${ic("clock", 24, "var(--ver)")} Commit deadline<span class="ff" style="margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--chain);font-size:19px">${ic("ff", 20)} time travel (anvil)</span></div>
        <div style="position:relative;margin-top:18px;height:12px;border-radius:6px;background:rgba(255,255,255,.08)"><div class="fl" style="position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:var(--ver)"></div>
          <div style="position:absolute;left:${(600 / 660) * 100}%;top:-10px;bottom:-10px;width:2px;background:#fff"></div>
          <div style="position:absolute;left:${(600 / 660) * 100}%;top:24px;transform:translateX(-50%);font-size:15px;color:var(--muted);white-space:nowrap">600 s</div></div>
        <div class="el mono tnum" style="margin-top:22px;font-size:22px"></div></div>`);
    const fl = dl.querySelector(".fl"), elp = dl.querySelector(".el"), ff = dl.querySelector(".ff");
    S.extra((t) => {
      const o = show(dl, t, 5.6, 10.4, { dy: 10 });
      if (o <= 0) return;
      const real = clamp(t - 5.8, 0, 1.2) * 4;
      const jump = P(t, 7.2, 1.6, E.inOut) * (601 - 4.8);
      const s = Math.min(601, real + jump);
      fl.style.width = (s / 660) * 100 + "%";
      fl.style.background = s >= 600 ? "var(--bad)" : "var(--ver)";
      ff.style.opacity = P(t, 7.0, 0.3) * (1 - P(t, 9.0, 0.4)) + (t > 9 ? 0.35 : 0);
      elp.innerHTML = `elapsed <b>${Math.floor(s)} s</b>` + (s >= 600 ? ` &nbsp;<span style="color:var(--bad);font-family:system-ui;font-weight:700">deadline missed</span>` : "");
    });
    cue("tick", 7.2);
    S.tl(9.0, 2);
    S.packet(9.8, 0.85, ANCH.clientR, ANCH.marketL, "var(--client)", "expire()");
    S.slash(10.8, "F", 0.1, 3, cue);
    S.escrow(11.0, 0.14);
    S.toClient(11.6, 0.14, 4);
    S.close(12.8, 5, "MAIN MISSED", "var(--ver)", "clock", cue);
    S.finish();
    return (t) => { hd(t); S.update(t); };
  },
});

// ================================================================ tests
scene({
  id: "tests", dur: 21, chapter: 2,
  build(root, cue) {
    const hd = header(root, "Under the hood", "Every outcome is asserted, not eyeballed", null, "var(--ok)");
    const term = add(root, `<div class="term abs" style="left:120px;top:290px;width:1040px;height:590px">
        <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="tt">zsh — DeGPU</span></div><div class="body mono"></div></div>`);
    const body = term.querySelector(".body");
    const ROWS = 24;
    const lines = Array.from({ length: ROWS }, () => add(body, `<div class="ln"></div>`));
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const color = (s) => {
      const e = esc(s);
      if (s.startsWith("$ ")) return `<span class="pr">$</span> <span class="wh">${e.slice(2)}</span>`;
      if (/^Scenario \d/.test(s)) return `<span class="hdc">${e}</span>`;
      if (/^=+$/.test(s)) return `<span style="color:#3b4560">${e}</span>`;
      if (s.includes("DEMO PASSED") || /\d+ (tests )?passed/.test(s)) return `<span class="okc" style="font-weight:700">${e}</span>`;
      return e.replace(/\[ok\]/g, '<span class="okc">[ok]</span>').replace(/^(\s*)\[(\w+)\]/, '$1<span style="color:var(--main)">[$2]</span>');
    };
    const demo = D.demoLines;
    const forge = D.forge.split(/(?<=\):) /);
    const dots = ".".repeat(55) + " ".repeat(18) + "[100%]";
    // timed program: [time, kind, text]
    const prog = [[1.0, "cmd", "uv run scripts/demo.py"]];
    const DEMO0 = 2.4, DEMO_D = 7.2;
    const after = [
      [10.4, "cmd", "(cd contracts && forge test)"],
      [12.0, "out", forge[0]], [12.1, "out", forge[1] ?? ""],
      [12.9, "cmd", "uv run pytest"],
      [14.2, "out", dots], [14.4, "out", D.pytest],
    ];
    const stats = [
      [9.8, "5 / 5", "demo scenarios pass", "Each asserts the outcome, every balance net of gas, and the labels the client decodes."],
      [12.2, "67", "Solidity tests · forge", "Every settlement case, reverts, random draws, gas and the deploy script."],
      [14.6, "55", "Python tests · pytest", "Crypto, storage, the ONNX runner, decoding, and end-to-end jobs on a real chain."],
    ].map(([t0, n, tt, d], k) => [add(root, `<div class="card stat abs" style="left:1220px;top:${290 + k * 200}px;width:600px;height:180px">
        <div class="row1"><div class="n grad">${n}</div><div class="t">${tt}</div></div><div class="d">${d}</div></div>`), t0]);
    cue("chime", 9.7);
    return (t, tau) => {
      hd(t);
      show(term, t, 0.6, Infinity, { dy: 24 });
      const out = [];
      const typed = (t0, text, speed = 26) => {
        const n = Math.floor(clamp((t - t0) * speed, 0, text.length));
        const cur = Math.floor(tau * 2.2) % 2 === 0 || n < text.length;
        return "$ " + text.slice(0, n) + (cur ? "\u0000" : "");
      };
      if (t >= prog[0][0]) out.push(typed(prog[0][0], prog[0][2]));
      const nd = Math.floor(demo.length * E.inOutSine(clamp((t - DEMO0) / DEMO_D)));
      for (let i = 0; i < nd; i++) out.push(demo[i]);
      if (out.length && nd > 0) out[0] = out[0].replace("\u0000", "");
      for (const [t0, kind, text] of after) {
        if (t < t0) break;
        if (out.length) out[out.length - 1] = out[out.length - 1].replace("\u0000", "");
        out.push(kind === "cmd" ? typed(t0, text) : text);
      }
      const view = out.slice(-ROWS);
      lines.forEach((ln, i) => {
        const s = view[i] ?? "";
        ln.innerHTML = color(s.replace("\u0000", "")) + (s.includes("\u0000") ? '<span class="cursor"></span>' : "");
      });
      stats.forEach(([el, t0]) => show(el, t, t0, Infinity, { dy: 24 }));
    };
  },
});

// ================================================================ reputation
scene({
  id: "rep", dur: 13, chapter: 2,
  build(root) {
    const hd = header(root, "After the demo", "Stakes and reputation live on-chain", null, "var(--chain)");
    const card = add(root, `<div class="card rep abs" style="left:120px;top:290px;width:1680px">
        <div class="row grp"><span class="c0"></span><span class="c1"></span><span style="width:500px;text-align:center">as main provider</span><span style="width:375px;text-align:center">as verifier / tie-breaker</span></div>
        <div class="row head"><span class="c0">Provider</span><span class="c1">Stake (ETH)</span>
          ${["verified", "unverified", "missed", "outvoted", "checks", "missed", "outvoted"].map((s) => `<span class="cn">${s}</span>`).join("")}<span class="cs">status</span></div></div>`);
    const rows = D.reputation.map(([n, stake, ...c]) => {
      const bad = [false, false, true, true, false, true, true];
      const active = stake >= 0.8;
      const el = add(card, `<div class="row"><span class="c0" style="display:flex;align-items:center;gap:14px"><span class="av" style="width:40px;height:40px;font-size:19px;background:#cbd5e1">${n}</span></span>
          <span class="c1"><span class="sbar"><i style="background:${active ? "#94a3b8" : "var(--bad)"}"></i><span class="min"></span></span><span class="mono stk" style="color:${active ? "var(--text)" : "var(--bad)"}">${stake.toFixed(3)}</span></span>
          ${c.map((v, k) => `<span class="cn tnum ${v ? "" : "z"}" style="${v && bad[k] ? "color:var(--bad);font-weight:750" : v ? "font-weight:700" : ""}">${v}</span>`).join("")}
          <span class="cs"><span class="pill" style="font-size:15px;${active ? "background:rgba(74,222,128,.13);color:var(--ok)" : "background:rgba(248,113,113,.14);color:var(--bad)"}">${active ? "active" : "suspended"}</span></span></div>`);
      return { el, bar: el.querySelector(".sbar i"), stake };
    });
    return (t) => {
      hd(t);
      show(card, t, 0.8, Infinity, { dy: 24 });
      rows.forEach(({ el, bar, stake }, i) => {
        show(el, t, 1.2 + i * 0.12, Infinity, { dy: 10, blur: 3 });
        bar.style.width = stake * P(t, 1.5 + i * 0.12, 1.0) * 100 + "%";
      });
    };
  },
});

// ================================================================ economics
scene({
  id: "econ", dur: 16.5, chapter: 3,
  build(root) {
    const hd = header(root, "Incentives", "Why cheating doesn’t pay", null, "var(--ver)");
    const MAXW = 900;
    const b1 = add(root, `<div class="econ abs" style="left:120px;top:310px;width:${MAXW}px"><div class="lb">Most a cheater can gain on one job <span class="c-muted">(the job price)</span></div>
        <div class="barw" style="width:${(0.02 / 0.3) * MAXW}px;background:var(--ok)"><span class="v c-ok mono">0.020 ETH</span></div></div>`);
    const b2 = add(root, `<div class="econ abs" style="left:120px;top:460px;width:${MAXW}px"><div class="lb">What it loses when caught <span class="c-muted">(30% of its 1 ETH stake)</span></div>
        <div class="barw" style="width:${MAXW}px;background:var(--bad)"><span class="v c-bad mono">0.300 ETH</span></div></div>`);
    const x15 = add(root, `<div class="abs" style="left:1330px;top:330px;width:420px;text-align:center"><div class="grad" style="font-size:150px;font-weight:850;line-height:1;letter-spacing:-.04em">15×</div><div style="font-size:24px;color:var(--muted);margin-top:12px">more to lose than to gain</div></div>`);
    const tiles = Array.from({ length: 15 }, (_, i) => add(root, `<div class="jt abs" style="left:${120 + i * 112}px;top:680px">${ic(i === 9 ? "shield" : "photo", 26)}<span>${i === 9 ? "checked" : "job"}</span></div>`));
    return (t) => {
      hd(t);
      show(b1, t, 1.0); show(b2, t, 4.0);
      b1.querySelector(".barw").style.transform = `scaleX(${P(t, 1.4, 0.8)})`;
      b1.querySelector(".barw").style.transformOrigin = "0 50%";
      const bw2 = b2.querySelector(".barw");
      bw2.style.width = MAXW * P(t, 4.4, 1.6, E.inOut) + "px";
      b1.querySelector(".v").style.opacity = P(t, 2.0, 0.4);
      bw2.querySelector(".v").style.opacity = P(t, 5.8, 0.4);
      show(x15, t, 6.3, Infinity, { dy: 0, s0: 0.85, blur: 10 });
      tiles.forEach((el, i) => {
        show(el, t, 8.4 + i * 0.06, Infinity, { dy: 14 });
        const k = P(t, 10.4, 0.6, E.outBack);
        if (i === 9) {
          el.style.borderColor = `rgba(251,191,36,${0.09 + 0.6 * k})`;
          el.style.background = `rgba(251,191,36,${0.045 + 0.12 * k})`;
          el.style.color = k > 0.5 ? "var(--ver)" : "var(--muted)";
          el.style.transform += ` scale(${lerp(1, 1.12, k)})`;
          el.lastElementChild.textContent = t >= 10.4 ? "checked" : "job";
          el.firstElementChild.innerHTML = t >= 10.4 ? IC.shield : IC.photo;
        }
      });
    };
  },
});

// ================================================================ limitations
scene({
  id: "limits", dur: 14, chapter: 3,
  build(root) {
    const hd = header(root, "Known limitations", "What we deliberately left out", null, "var(--muted)");
    const items = [
      ["eye", "The main provider sees every image", "Hiding data from it would need secure hardware (TEEs)."],
      ["coins", "Verified jobs cost 2× the price", "So verify only some jobs; the hidden decision protects the rest."],
      ["dice", "Demo-grade randomness", "Draws use prevrandao and blockhash; Chainlink VRF is the upgrade."],
      ["layers", "Every result leaf goes on-chain", "Fine up to 1,000 items; a Merkle root with proofs would scale it."],
      ["db", "Local storage stands in for IPFS", "No web UI or testnet deployment yet."],
    ].map(([icon, t, d], k) => add(root, `<div class="card lim abs" style="left:120px;top:${290 + k * 112}px">
        <span class="iconbox" style="--c:#94a3b8">${ic(icon, 28)}</span><span class="t">${t}</span><span class="d">${d}</span></div>`));
    return (t) => { hd(t); items.forEach((el, k) => show(el, t, 0.9 + k * 0.4, Infinity, { dy: 20 })); };
  },
});

// ================================================================ try it
scene({
  id: "try", dur: 12, chapter: 3,
  build(root) {
    const hd = header(root, "Try it", "Run it yourself", null, "var(--client)");
    const cmds = [
      ["uv sync", ""],
      ["uv run scripts/fetch_demo_assets.py", "# model + 200 photos"],
      ["(cd contracts && forge test)", "# 67 Solidity tests"],
      ["uv run pytest", "# 55 Python tests"],
      ["uv run scripts/demo.py", "# the five scenarios"],
    ];
    const code = add(root, `<div class="card code mono abs" style="left:120px;top:300px;width:1060px;height:400px;display:flex;flex-direction:column;justify-content:center"></div>`);
    const ls = cmds.map(([c, cm]) => add(code, `<div><span class="pr">$</span> ${c.padEnd(38, " ")}<span class="cm">${cm}</span></div>`));
    const links = [
      ["book", "README.md", "Architecture, job flow and every settlement outcome."],
      ["book", "docs/INTERFACE.md", "The shared interface spec (v2): names, encodings, rules."],
      ["play", "video/", "This video. Re-render it from a fresh demo run."],
    ].map(([icon, t, d], k) => add(root, `<div class="card link abs" style="left:1240px;top:${300 + k * 140}px;height:120px">
        <div class="t">${ic(icon, 26, "var(--client)")}<span class="mono" style="font-size:25px">${t}</span></div><div class="d">${d}</div></div>`));
    return (t) => {
      hd(t);
      show(code, t, 0.8, Infinity, { dy: 24 });
      ls.forEach((l, i) => show(l, t, 1.3 + i * 0.35, Infinity, { dy: 8, blur: 3 }));
      links.forEach((l, i) => show(l, t, 2.4 + i * 0.3, Infinity, { dy: 18 }));
    };
  },
});

// ================================================================ outro
scene({
  id: "outro", dur: 9, chapter: null,
  build(root) {
    const logo = add(root, `<div class="abs" style="left:0;right:0;top:330px;display:flex;justify-content:center">${logoSVG(110)}</div>`);
    const t1 = add(root, `<div class="abs" style="left:0;right:0;top:470px;text-align:center;font-size:76px;font-weight:780;letter-spacing:-.03em">Thanks for watching</div>`);
    const t2 = add(root, `<div class="abs" style="left:0;right:0;top:574px;text-align:center;font-size:30px;color:var(--muted)"><span class="grad" style="font-weight:750">DeGPU</span> · cheap compute, secretly checked, settled on-chain</div>`);
    return (t) => {
      show(logo, t, 0.7, Infinity, { dy: 0, s0: 0.8, blur: 10, d: 1.0 });
      show(t1, t, 1.1, Infinity, { dy: 20, blur: 8, d: 1.0 });
      show(t2, t, 1.7, Infinity, { dy: 14, d: 1.0 });
    };
  },
});

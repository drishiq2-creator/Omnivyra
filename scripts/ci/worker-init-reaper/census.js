'use strict';
// GI-07 process census (CI only). Run with `docker exec` inside the worker
// container; reads /proc of the container's PID namespace and prints one JSON
// line. `--kill-live-chrome` SIGKILLs live Chromium processes first (cleanup of
// the known post-crash straggler, so later scenarios start clean).
const fs = require('fs');

function procs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const m = fs.readFileSync(`/proc/${d}/stat`, 'utf8').match(/^(\d+) \((.*)\) (\S) (\d+)/);
      if (m) out.push({ pid: Number(m[1]), comm: m[2], state: m[3], ppid: Number(m[4]) });
    } catch { /* raced exit */ }
  }
  return out;
}
const isChrome = (p) => /chrom|headless_shell/i.test(p.comm);

let killed = 0;
if (process.argv.includes('--kill-live-chrome')) {
  for (const p of procs()) {
    if (isChrome(p) && p.state !== 'Z') { try { process.kill(p.pid, 'SIGKILL'); killed += 1; } catch { /* gone */ } }
  }
}
setTimeout(() => {
  const all = procs().filter((p) => p.pid !== process.pid);
  const pid1 = all.find((p) => p.pid === 1);
  const zombies = all.filter((p) => p.state === 'Z');
  console.log(JSON.stringify({
    pid1: pid1 ? pid1.comm : null,
    pid1Children: all.filter((p) => p.ppid === 1).map((p) => p.comm),
    zombies: zombies.length,
    zombieComms: [...new Set(zombies.map((p) => p.comm))],
    liveChrome: all.filter((p) => isChrome(p) && p.state !== 'Z').length,
    killed,
  }));
}, killed ? 1500 : 800);

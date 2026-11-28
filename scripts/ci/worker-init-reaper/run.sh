#!/usr/bin/env bash
# GI-07 worker init/reaper scenarios (CI only; .github/workflows/worker-init-reaper.yml).
#
# Usage: run.sh <image built from Dockerfile.worker> [output dir]
#
# Every scenario runs twice against the SAME image:
#   tini     the image as built: ENTRYPOINT tini -- docker-entrypoint.sh (the fix)
#   control  --entrypoint docker-entrypoint.sh, i.e. exactly the pre-fix process
#            chain (the base image's entrypoint execs node, so node is PID 1)
# The control must reproduce the zombie defect (proves the census can see it), and
# every signal/queue outcome must be identical in both modes (proves the fix leaves
# shutdown and queue behaviour unchanged). Redis is a throwaway local container;
# the harness serves 127.0.0.1 pages only; no secrets or production services.
set -uo pipefail

IMG="${1:?usage: run.sh <image> [outdir]}"
OUT="${2:-${RUNNER_TEMP:-/tmp}/gi07-out}"
H="$(cd "$(dirname "$0")" && pwd)"
NET=gi07net
FAIL=0
mkdir -p "$OUT"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAIL=1; }
expect_eq() { if [ -n "$2" ] && [ "$2" = "$3" ]; then pass "$1 = $2"; else fail "$1 = ${2:-<empty>} (expected ${3:-<empty>})"; fi; }

docker network create "$NET" >/dev/null
docker run -d --name redis --network "$NET" redis:7.4.2-alpine >/dev/null

declare -A R

wait_ready() { # <n>: wait until the worker has logged its n-th HARNESS_READY
  for _ in $(seq 1 240); do
    [ "$(docker logs gi07w 2>&1 | grep -c HARNESS_READY)" -ge "$1" ] && return 0
    sleep 0.5
  done
  fail "worker never reached READY #$1"; docker logs gi07w 2>&1 | tail -30; docker logs gi07w >"$OUT/worker-not-ready.log" 2>&1; docker rm -f gi07w >/dev/null 2>&1; return 1
}
wait_log() { # <line>: wait until the worker has logged it
  for _ in $(seq 1 120); do
    docker logs gi07w 2>&1 | grep -qF "$1" && return 0
    sleep 0.25
  done
  fail "worker never logged: $1"; return 1
}
hp() { docker run --rm --network "$NET" -e REDIS_HOST=redis -e HARNESS_QUEUE="$Q" -v "$H:/harness:ro" --entrypoint node "$IMG" /harness/harness.js "$@"; }
census() { docker exec gi07w node /harness/census.js "$@"; }
exitcode() { docker inspect -f '{{.State.ExitCode}}' "$1"; }
jobid() { awk '/^PRODUCED/{print $3}' <<<"$1"; }

scenarios() {
  local m=$1 c out jid
  Q="gi07-$m"
  local entry=()
  [ "$m" = control ] && entry=(--entrypoint docker-entrypoint.sh)
  docker run -d --name gi07w --network "$NET" -e REDIS_HOST=redis -e HARNESS_QUEUE="$Q" \
    -v "$H:/harness:ro" "${entry[@]}" "$IMG" node /harness/harness.js worker >/dev/null
  wait_ready 1 || return
  c=$(census); echo "CENSUS $m boot $c"
  R[$m.pid1]=$(jq -r .pid1 <<<"$c")

  # S1 repeated launch/close through the real queue path
  hp produce cycle 20 0 completed || fail "$m S1 produce"
  c=$(census); echo "CENSUS $m S1 $c"
  R[$m.S1zombies]=$(jq .zombies <<<"$c"); R[$m.S1liveChrome]=$(jq .liveChrome <<<"$c")

  # S2 forced crash: SIGKILL of the browser main process inside a job
  hp produce crash 3 0 completed || fail "$m S2 produce"
  c=$(census); echo "CENSUS $m S2 $c"
  R[$m.S2zombies]=$(jq .zombies <<<"$c"); R[$m.S2liveChrome]=$(jq .liveChrome <<<"$c")
  c=$(census --kill-live-chrome); echo "CENSUS $m S2-cleanup $c"
  R[$m.S2zombiesAfterCleanup]=$(jq .zombies <<<"$c")

  # S3 normal shutdown: SIGTERM (docker stop) with a job in flight
  # The signal is sent only once the job is HOLDING its open browser, so every
  # run tests the same moment. Playwright's default handleSIGTERM closes the
  # browser on SIGTERM, so the job's next page call fails: that is pre-existing
  # production behaviour (not tini's), asserted EQUAL across modes, and S3b
  # shows that handleSIGTERM:false lets the drain finish the job.
  out=$(hp produce hold 1 8000 active); echo "$out"; jid=$(jobid "$out")
  wait_log "HARNESS_HOLDING $jid"
  docker stop -t 30 gi07w >/dev/null
  R[$m.S3exit]=$(exitcode gi07w)
  R[$m.S3sigterms]=$(docker logs gi07w 2>&1 | grep -c 'HARNESS_SIGNAL SIGTERM')
  R[$m.S3drained]=$(docker logs gi07w 2>&1 | grep -c HARNESS_DRAINED)
  R[$m.S3hardExit]=$(docker logs gi07w 2>&1 | grep -c HARNESS_HARD_EXIT)
  R[$m.S3jobState]=$(hp state "$jid" | awk '/^STATE/{print $3}')

  # S4 forced termination (SIGKILL) mid-job, then restart recovery
  docker start gi07w >/dev/null; wait_ready 2 || return
  c=$(census); echo "CENSUS $m restart $c"
  out=$(hp produce hold 1 8000 active); echo "$out"; jid=$(jobid "$out")
  docker kill -s KILL gi07w >/dev/null; timeout 60 docker wait gi07w >/dev/null || fail "container did not stop within 60s"
  R[$m.S4exit]=$(exitcode gi07w)
  docker start gi07w >/dev/null; wait_ready 3 || return
  R[$m.S4jobState]=$(hp wait "$jid" 90000 | awk '/^WAITED/{print $3}')
  if hp produce cycle 3 0 completed >/dev/null; then R[$m.S4newJobs]=ok; else R[$m.S4newJobs]=failed; fi
  c=$(census); echo "CENSUS $m S4 $c"
  R[$m.S4zombies]=$(jq .zombies <<<"$c")

  # S5 SIGINT
  docker kill -s INT gi07w >/dev/null; timeout 60 docker wait gi07w >/dev/null || fail "container did not stop within 60s"
  R[$m.S5exit]=$(exitcode gi07w)
  R[$m.S5sigints]=$(docker logs gi07w 2>&1 | grep -c 'HARNESS_SIGNAL SIGINT')

  # S3b the same in-flight SIGTERM with Playwright's signal handling turned off.
  docker start gi07w >/dev/null; wait_ready 4 || return
  out=$(hp produce holdnohandler 1 8000 active); echo "$out"; jid=$(jobid "$out")
  wait_log "HARNESS_HOLDING $jid"
  docker stop -t 30 gi07w >/dev/null
  R[$m.S3bexit]=$(exitcode gi07w)
  R[$m.S3bjobState]=$(hp state "$jid" | awk '/^STATE/{print $3}')

  # GI-NEW-1 (CI-ONLY): the same in-flight shutdowns, launched with the SHIPPED
  # helper compiled into this image (dist/backend/services/playwrightLaunchOptions.js).
  # Each segment's log lines are counted from its own start (docker logs keeps
  # every run of the container), via the line count taken before it.
  local base
  # S3c SIGTERM, shipped helper: the drain finishes the job.
  docker start gi07w >/dev/null; wait_ready 5 || return
  base=$(docker logs gi07w 2>&1 | wc -l)
  out=$(hp produce holdshipped 1 8000 active); echo "$out"; jid=$(jobid "$out")
  wait_log "HARNESS_HOLDING $jid"
  docker stop -t 30 gi07w >/dev/null
  R[$m.S3cexit]=$(exitcode gi07w)
  R[$m.S3cshippedOpts]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c 'HARNESS_SHIPPED_OPTS .*"handleSIGINT":false,"handleSIGTERM":false,"handleSIGHUP":false')
  R[$m.S3cdrained]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c HARNESS_DRAINED)
  R[$m.S3chardExit]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c HARNESS_HARD_EXIT)
  R[$m.S3cpreExitLiveChrome]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | awk -F'liveChrome=' '/HARNESS_PRE_EXIT/{print $2}' | tail -1)
  R[$m.S3cjobState]=$(hp state "$jid" | awk '/^STATE/{print $3}')

  # S3h SIGHUP, shipped helper: Playwright no longer listens for SIGHUP, so the
  # worker's own handler must drain (as main.ts does after GI-NEW-1).
  docker start gi07w >/dev/null; wait_ready 6 || return
  base=$(docker logs gi07w 2>&1 | wc -l)
  out=$(hp produce holdshipped 1 8000 active); echo "$out"; jid=$(jobid "$out")
  wait_log "HARNESS_HOLDING $jid"
  docker kill -s HUP gi07w >/dev/null; timeout 60 docker wait gi07w >/dev/null || fail "container did not stop within 60s"
  R[$m.S3hexit]=$(exitcode gi07w)
  R[$m.S3hsighups]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c 'HARNESS_SIGNAL SIGHUP')
  R[$m.S3hdrained]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c HARNESS_DRAINED)
  R[$m.S3hpreExitLiveChrome]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | awk -F'liveChrome=' '/HARNESS_PRE_EXIT/{print $2}' | tail -1)
  R[$m.S3hjobState]=$(hp state "$jid" | awk '/^STATE/{print $3}')
  R[$m.S3hhostChromeAfter]=$(ps -eo comm= | grep -Eci 'chrom|headless_shell')

  # S6c a job that outlives the harness's 20 s hard-exit backstop (docker stop
  # -t 30 leaves room for it): the drain cannot finish, the backstop exits 0,
  # the job is NOT completed, and no Chromium survives the container. Last in
  # the mode: the abandoned job would otherwise be re-run by a restarted worker.
  docker start gi07w >/dev/null; wait_ready 7 || return
  base=$(docker logs gi07w 2>&1 | wc -l)
  out=$(hp produce holdshipped 1 40000 active); echo "$out"; jid=$(jobid "$out")
  wait_log "HARNESS_HOLDING $jid"
  docker stop -t 30 gi07w >/dev/null
  R[$m.S6cexit]=$(exitcode gi07w)
  R[$m.S6cdrained]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c HARNESS_DRAINED)
  R[$m.S6chardExit]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | grep -c HARNESS_HARD_EXIT)
  R[$m.S6chardExitLiveChrome]=$(docker logs gi07w 2>&1 | tail -n +$((base + 1)) | awk -F'liveChrome=' '/HARNESS_HARD_EXIT/{print $2}' | tail -1)
  R[$m.S6cjobState]=$(hp state "$jid" | awk '/^STATE/{print $3}')
  R[$m.S6chostChromeAfter]=$(ps -eo comm= | grep -Eci 'chrom|headless_shell')

  docker logs gi07w >"$OUT/worker-$m.log" 2>&1
  docker rm -f gi07w >/dev/null
}

# S6 the real entrypoint + real dist/backend/workers/main.js, no env, no network:
# whatever main.js does without configuration, both modes must do the same and
# report the same exit status.
real_main() {
  local m=$1 entry=() code running c
  [ "$m" = control ] && entry=(--entrypoint docker-entrypoint.sh)
  if [ "$m" = control ]; then
    docker run -d --name real --network none -v "$H:/harness:ro" "${entry[@]}" "$IMG" node dist/backend/workers/main.js >/dev/null
  else
    docker run -d --name real --network none -v "$H:/harness:ro" "$IMG" >/dev/null
  fi
  sleep 20
  running=$(docker inspect -f '{{.State.Running}}' real)
  if [ "$running" = true ]; then
    c=$(docker exec real node /harness/census.js); echo "CENSUS $m real-main $c"
    R[$m.S6pid1]=$(jq -r .pid1 <<<"$c")
    docker stop -t 30 real >/dev/null
  else
    R[$m.S6pid1]=exited-before-census
  fi
  code=$(exitcode real)
  R[$m.S6runningAt20s]=$running
  R[$m.S6exit]=$code
  R[$m.S6gracefulLog]=$(docker logs real 2>&1 | grep -c 'shutting down gracefully')
  docker logs real >"$OUT/real-main-$m.log" 2>&1
  docker rm -f real >/dev/null
}

# S7 the REAL worker lifecycle: the image's own entrypoint and main.js, configured
# with throwaway dummy values (no real credential exists in this job), on an
# --internal network whose only reachable host is the local Redis, so nothing can
# leave the runner. SUPABASE_URL points at a closed local port. Boot, wait, then
# SIGTERM: main.ts's real graceful shutdown must run once and exit 0, inside the
# 30 s Railway draining window.
INT_NET=gi07int
real_env() {
  printf '%s\n' \
    "SUPABASE_URL=http://127.0.0.1:9" "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9" \
    "SUPABASE_SECRET_KEY=ci-dummy-not-a-key" "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-dummy-not-a-key" \
    "REDIS_URL=redis://redis:6379" "OPENAI_API_KEY=ci-dummy-not-a-key" \
    "ENCRYPTION_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    "SESSION_COOKIE_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}
start_real() { # <mode> <name>
  local entry=()
  [ "$1" = control ] && entry=(--entrypoint docker-entrypoint.sh)
  if [ "$1" = control ]; then
    docker run -d --name "$2" --network "$INT_NET" --env-file "$OUT/real.env" -v "$H:/harness:ro" "${entry[@]}" "$IMG" node dist/backend/workers/main.js >/dev/null
  else
    docker run -d --name "$2" --network "$INT_NET" --env-file "$OUT/real.env" -v "$H:/harness:ro" "$IMG" >/dev/null
  fi
}
real_lifecycle() {
  local m=$1 c t0 t1
  start_real "$m" gi07real
  sleep 45
  R[$m.S7runningAt45s]=$(docker inspect -f '{{.State.Running}}' gi07real)
  if [ "${R[$m.S7runningAt45s]}" = true ]; then
    c=$(docker exec gi07real node /harness/census.js); echo "CENSUS $m real-lifecycle $c"
    R[$m.S7pid1]=$(jq -r .pid1 <<<"$c")
    t0=$(date +%s); docker stop -t 30 gi07real >/dev/null; t1=$(date +%s)
    R[$m.S7stopWithin30s]=$([ $((t1 - t0)) -lt 30 ] && echo yes || echo no)
  else
    echo "S7 $m: real worker exited before 45 s; its fatal lines:"
    docker logs gi07real 2>&1 | grep -E 'FATAL|Error|❌|exit' | grep -v 'Direct process.env' | head -15 | sed 's/^/  S7LOG /'
  fi
  R[$m.S7exit]=$(exitcode gi07real)
  R[$m.S7sigtermLogged]=$(docker logs gi07real 2>&1 | grep -c '\[main\] SIGTERM received')
  R[$m.S7shutdownReported]=$(docker logs gi07real 2>&1 | grep -cE '\[main\] shutdown (complete|finished WITHOUT a clean drain)')
  R[$m.S7hardExit]=$(docker logs gi07real 2>&1 | grep -c 'shutdown exceeded its budget')
  docker logs gi07real >"$OUT/real-lifecycle-$m.log" 2>&1
  docker rm -f gi07real >/dev/null

  # S8 a signal that arrives during boot, before main.ts installs its handlers
  # (characterised, not asserted equal: node is PID 1 only in the control).
  start_real "$m" gi07early
  sleep 0.3
  docker kill -s TERM gi07early >/dev/null 2>&1
  sleep 15
  R[$m.S8runningAfterEarlySigterm]=$(docker inspect -f '{{.State.Running}}' gi07early)
  R[$m.S8exitIfStopped]=$(docker inspect -f '{{.State.ExitCode}}' gi07early)
  R[$m.S8sigtermLogged]=$(docker logs gi07early 2>&1 | grep -c '\[main\] SIGTERM received')
  docker logs gi07early >"$OUT/early-sigterm-$m.log" 2>&1
  docker rm -f gi07early >/dev/null
}

echo "IMAGE $(docker inspect -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' "$IMG")"
expect_eq "image ENTRYPOINT" "$(docker inspect -f '{{json .Config.Entrypoint}}' "$IMG")" '["/usr/bin/tini","--","docker-entrypoint.sh"]'
expect_eq "image CMD" "$(docker inspect -f '{{json .Config.Cmd}}' "$IMG")" '["node","dist/backend/workers/main.js"]'

for m in control tini; do scenarios "$m"; real_main "$m"; done

docker network create --internal "$INT_NET" >/dev/null
docker network connect "$INT_NET" redis
real_env >"$OUT/real.env"
for m in control tini; do real_lifecycle "$m"; done
rm -f "$OUT/real.env"

for k in $(printf '%s\n' "${!R[@]}" | sort); do echo "RESULT $k=${R[$k]}"; done

# The control must reproduce the defect, or the zero below proves nothing.
expect_eq "control PID 1" "${R[control.pid1]:-}" node
if [ "${R[control.S1zombies]:-0}" -gt 0 ]; then pass "control reproduces GI-07 (zombies=${R[control.S1zombies]})"; else fail "control did NOT reproduce GI-07 (zombies=${R[control.S1zombies]:-?}): census cannot be trusted"; fi

# The fix.
expect_eq "tini PID 1" "${R[tini.pid1]:-}" tini
expect_eq "tini S1 zombies after 20 launch/close jobs" "${R[tini.S1zombies]:-}" 0
expect_eq "tini S1 live Chromium after 20 jobs" "${R[tini.S1liveChrome]:-}" 0
expect_eq "tini S2 zombies after forced crash" "${R[tini.S2zombies]:-}" 0
expect_eq "tini S2 zombies after straggler cleanup" "${R[tini.S2zombiesAfterCleanup]:-}" 0
expect_eq "tini S3 SIGTERM exit" "${R[tini.S3exit]:-}" 0
expect_eq "tini S3 SIGTERM delivered once" "${R[tini.S3sigterms]:-}" 1
expect_eq "tini S3 drained" "${R[tini.S3drained]:-}" 1
expect_eq "tini S3 no hard exit" "${R[tini.S3hardExit]:-}" 0
expect_eq "tini S3 in-flight job (Playwright default closes the browser on SIGTERM: pre-existing)" "${R[tini.S3jobState]:-}" failed
expect_eq "tini S3b in-flight job, handleSIGTERM false" "${R[tini.S3bjobState]:-}" completed
expect_eq "control S3b in-flight job, handleSIGTERM false" "${R[control.S3bjobState]:-}" completed
expect_eq "tini S3b exit" "${R[tini.S3bexit]:-}" 0

# GI-NEW-1 (CI-ONLY): the shipped helper, in BOTH modes.
for m in tini control; do
  expect_eq "$m S3c shipped helper set all three flags false" "${R[$m.S3cshippedOpts]:-}" 1
  expect_eq "$m S3c in-flight job, SIGTERM, shipped helper" "${R[$m.S3cjobState]:-}" completed
  expect_eq "$m S3c exit" "${R[$m.S3cexit]:-}" 0
  expect_eq "$m S3c drained" "${R[$m.S3cdrained]:-}" 1
  expect_eq "$m S3c no hard exit" "${R[$m.S3chardExit]:-}" 0
  expect_eq "$m S3c live Chromium before exit" "${R[$m.S3cpreExitLiveChrome]:-}" 0
  expect_eq "$m S3h SIGHUP delivered once" "${R[$m.S3hsighups]:-}" 1
  expect_eq "$m S3h in-flight job, SIGHUP, shipped helper" "${R[$m.S3hjobState]:-}" completed
  expect_eq "$m S3h exit" "${R[$m.S3hexit]:-}" 0
  expect_eq "$m S3h drained" "${R[$m.S3hdrained]:-}" 1
  expect_eq "$m S3h live Chromium before exit" "${R[$m.S3hpreExitLiveChrome]:-}" 0
  expect_eq "$m S3h host Chromium after exit" "${R[$m.S3hhostChromeAfter]:-}" 0
  expect_eq "$m S6c exit (hard-exit backstop)" "${R[$m.S6cexit]:-}" 0
  expect_eq "$m S6c not drained" "${R[$m.S6cdrained]:-}" 0
  expect_eq "$m S6c hard exit fired" "${R[$m.S6chardExit]:-}" 1
  expect_eq "$m S6c job abandoned, not completed" "${R[$m.S6cjobState]:-}" active
  expect_eq "$m S6c host Chromium after exit" "${R[$m.S6chostChromeAfter]:-}" 0
  if [ "${R[$m.S6chardExitLiveChrome]:-0}" -ge 1 ]; then
    pass "$m S6c browser still alive at the hard exit (liveChrome=${R[$m.S6chardExitLiveChrome]}): the kill above is real"
  else
    fail "$m S6c no live Chromium at the hard exit (liveChrome=${R[$m.S6chardExitLiveChrome]:-?}): host-after=0 proves nothing"
  fi
done
expect_eq "tini S4 SIGKILL exit" "${R[tini.S4exit]:-}" 137
expect_eq "tini S4 interrupted job after restart" "${R[tini.S4jobState]:-}" completed
expect_eq "tini S4 new jobs after restart" "${R[tini.S4newJobs]:-}" ok
expect_eq "tini S4 zombies after restart" "${R[tini.S4zombies]:-}" 0
expect_eq "tini S5 SIGINT exit" "${R[tini.S5exit]:-}" 0
expect_eq "tini S5 SIGINT delivered once" "${R[tini.S5sigints]:-}" 1

# Behaviour preserved: identical outcomes in both modes.
for k in S3exit S3sigterms S3drained S3hardExit S3jobState S3bexit S3bjobState S4exit S4jobState S4newJobs S5exit S5sigints S6runningAt20s S6exit S6gracefulLog; do
  expect_eq "same in both modes: $k" "${R[tini.$k]:-}" "${R[control.$k]:-}"
done
[ "${R[tini.S6runningAt20s]:-}" = true ] && expect_eq "tini S6 real main.js PID 1" "${R[tini.S6pid1]:-}" tini

# S7: the real worker must actually have booted, or the lifecycle was not exercised.
expect_eq "tini S7 real worker up at 45 s" "${R[tini.S7runningAt45s]:-}" true
expect_eq "control S7 real worker up at 45 s" "${R[control.S7runningAt45s]:-}" true
expect_eq "tini S7 real worker PID 1" "${R[tini.S7pid1]:-}" tini
expect_eq "tini S7 main.ts saw SIGTERM once" "${R[tini.S7sigtermLogged]:-}" 1
expect_eq "tini S7 shutdown reported" "${R[tini.S7shutdownReported]:-}" 1
expect_eq "tini S7 no hard-exit backstop" "${R[tini.S7hardExit]:-}" 0
expect_eq "tini S7 exit" "${R[tini.S7exit]:-}" 0
expect_eq "tini S7 stopped inside the 30 s window" "${R[tini.S7stopWithin30s]:-}" yes
for k in S7sigtermLogged S7shutdownReported S7hardExit S7exit S7stopWithin30s; do
  expect_eq "same in both modes: $k" "${R[tini.$k]:-}" "${R[control.$k]:-}"
done

docker rm -f redis >/dev/null; docker network rm "$NET" "$INT_NET" >/dev/null
if [ "$FAIL" = 0 ]; then echo "GI07_VERDICT PASS"; else echo "GI07_VERDICT FAIL"; fi
exit "$FAIL"

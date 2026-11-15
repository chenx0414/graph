#!/usr/bin/env python3
import json, os, subprocess, sys, time

state = os.path.expanduser("~/Library/Application Support/Graph/state")
console = json.load(open(os.path.join(state, "console.json")))
url = console["url"].rstrip("/")
token = open(os.path.join(state, "session-token")).read().strip()
main = os.environ.get("GRAPH_PERF_CONVERSATION", "ebd518f3-312f-4f8c-bf8b-7d34f77d3151")
limit = json.load(open(os.path.join(os.path.dirname(__file__), "ratchet.json")))
path = "/api/conversations/" + main
times = []
for _ in range(10):
    start = time.perf_counter()
    subprocess.run(["curl", "-sf", "-o", "/dev/null", "-H", "Origin: " + url,
                    "-H", "Cookie: graph_session=" + token, url + path], check=True)
    times.append((time.perf_counter() - start) * 1000)
times.sort()
p50, p75 = times[4], times[7]
print("conversation p50=%.1fms p75=%.1fms" % (p50, p75))
ok = p75 <= limit["conversation_p75_ms"] and p50 <= limit["conversation_p50_ms"]
print("ratchet", "ok" if ok else "REGRESSED", "(limits p50<=%s p75<=%s)" %
      (limit["conversation_p50_ms"], limit["conversation_p75_ms"]))
sys.exit(0 if ok else 1)

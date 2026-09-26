---
name: heartbeat-check
created-by: graph-agent
description: Verify a service is still answering before blaming the code. Use when a long-running process stops responding and you need to separate a dead process from a slow one.
---

# Heartbeat check

Use this when a long-running process stops answering and you need to tell a dead process from a slow one.

## Procedure

1. Read the process id the launcher recorded and confirm it is still alive (`ps -p <pid>`).
2. Ask the process itself for one cheap round trip; a timeout here means the process is alive but stuck.
3. Only after both checks, look at the code.

## Pitfalls

- A refused connection and a hanging request are different failures: the first means nothing is listening, the second means the listener is not making progress.
- Killing the process before step 2 throws away the only evidence of where it stuck.

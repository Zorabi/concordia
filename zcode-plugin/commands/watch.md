---
description: Watch a Concordia task for new events until completion or interruption
argument-hint: "<task-id>"
---

Watch task `$1` using Concordia MCP. If no task ID is provided, ask the user for one. First call `get_task` to establish the most recent event cursor, then repeatedly call `wait_events` with that task ID, the latest event ID, and a bounded timeout. Show only newly received events and advance the cursor after each response.

Stop when the task reaches `APPROVED`, `FAILED`, or `CANCELLED`, when the user asks to stop, or when the observation limit is reached. On timeout, say that no new event arrived and continue only while the user still wants to watch.

---
description: List Concordia tasks available in this workspace
argument-hint: "[status]"
---

Use the Concordia MCP `list_tasks` tool to list tasks for the current workspace. If `$ARGUMENTS` supplies one or more statuses, use them as the status filter; otherwise show all recent tasks.

Render a compact table with `ID`, `STATUS`, `ASSIGNEE`, `UPDATED`, and `OBJECTIVE`. State clearly when no matching tasks exist. Do not claim or change any task from this command.

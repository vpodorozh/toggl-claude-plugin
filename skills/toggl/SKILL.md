---
name: toggl
description: >
  Use this skill when the user mentions Toggl, time tracking, logging hours, logging time,
  tracking work, "how much did I work", "what did I track", "log X hours on Y",
  "start tracking", "stop timer", or anything related to tracking time spent on tasks or projects.
version: 1.0.0
---

# Toggl Time Tracking

You have access to five Toggl MCP tools. Use them to help the user log and review their time.

## Tools Available

| Tool | Purpose |
|------|---------|
| `toggl_get_me` | Get user info and workspace ID |
| `toggl_list_projects` | List projects (id + name) |
| `toggl_list_time_entries` | Query entries by date range |
| `toggl_create_time_entry` | Log a completed time entry |
| `toggl_get_current_timer` | Check what's currently running |

## Interpreting Natural Language Requests

### Logging time
"Log 2h on Design today" →
1. Call `toggl_list_projects` to find the project ID matching "Design"
2. Call `toggl_create_time_entry` with description="Design work", duration_minutes=120, start=today's date, project_id=<matched id>

"Log 90 minutes debugging the auth bug yesterday" →
- duration_minutes=90, start=yesterday's date YYYY-MM-DD, description="Debugging auth bug"

"Log 1.5h on client work on Monday" →
- duration_minutes=90, start=that Monday's YYYY-MM-DD

**Duration parsing:**
- "2h" → 120 minutes
- "1.5h" / "1h 30m" / "90 minutes" → 90 minutes
- "30m" → 30 minutes
- Always convert to minutes before calling the tool

**Date parsing (relative to today = 2026-05-08):**
- "today" → 2026-05-08
- "yesterday" → 2026-05-07
- "last Monday" → the most recent past Monday
- Always pass YYYY-MM-DD format

**Project matching:**
- Call `toggl_list_projects` first if a project name is mentioned
- Match case-insensitively, partial match is fine ("Design" matches "UI Design")
- If no match, log without project_id and tell the user

### Querying time
"What did I track today?" → `toggl_list_time_entries` with start_date=today
"Show this week's entries" → start_date=Monday, end_date=today
"How much time did I log last week?" → start_date=last Monday, end_date=last Sunday, then sum durations

### Displaying results
When showing time entries:
- Group by project if multiple projects
- Show duration in hours+minutes (e.g. "1h 30m"), not raw minutes
- Sum total time at the end
- If project_id is present but you don't have project names, call `toggl_list_projects` to resolve names

### Checking running timer
"Is anything running?" / "What am I tracking?" → `toggl_get_current_timer`

## Error Handling

- If the API returns an error about the token, tell the user to check `~/.claude/toggl/credentials`
- If a project is not found, log without project and mention it
- If a date is ambiguous, make a reasonable assumption and confirm with the user after logging

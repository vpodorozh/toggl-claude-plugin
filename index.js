#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TOGGL_API_BASE = 'https://api.track.toggl.com/api/v9';
const CREDENTIALS_FILE = join(homedir(), '.claude', 'toggl', 'credentials');

// Load token: env var takes precedence, then credentials file
function loadToken() {
  if (process.env.TOGGL_API_TOKEN) return process.env.TOGGL_API_TOKEN.trim();
  if (existsSync(CREDENTIALS_FILE)) {
    return readFileSync(CREDENTIALS_FILE, 'utf8').trim();
  }
  process.stderr.write(
    `toggl-mcp: API token required.\n` +
    `  Option 1: set TOGGL_API_TOKEN environment variable\n` +
    `  Option 2: create ${CREDENTIALS_FILE} with your API token\n` +
    `  Get your token at: https://track.toggl.com/profile\n`
  );
  process.exit(1);
}

const API_TOKEN = loadToken();
const AUTH_HEADER = 'Basic ' + Buffer.from(`${API_TOKEN}:api_token`).toString('base64');

// Cached workspace ID to avoid repeated /me requests
let _workspaceId = null;

async function togglFetch(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': AUTH_HEADER,
      'Content-Type': 'application/json',
    },
  };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(`${TOGGL_API_BASE}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Toggl API ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getWorkspaceId() {
  if (_workspaceId) return _workspaceId;
  const me = await togglFetch('/me');
  _workspaceId = me.default_workspace_id;
  return _workspaceId;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'toggl_get_me',
    description:
      'Get the current Toggl user info: email, full name, timezone, and default workspace ID. ' +
      'Use this to look up the workspace ID before other workspace-scoped calls.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'toggl_list_projects',
    description:
      'List projects in the Toggl workspace. Returns id, name, color, and active status. ' +
      'Use this to resolve a project name to its numeric ID before logging time.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Return only active projects (default: true)',
        },
      },
    },
  },
  {
    name: 'toggl_list_time_entries',
    description:
      'List time entries for a date range. Returns description, duration, project ID, and timestamps. ' +
      'Use for queries like "what did I track today / this week / on 2025-01-10".',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (default: today)',
        },
        end_date: {
          type: 'string',
          description: 'End date YYYY-MM-DD (default: same as start_date)',
        },
      },
    },
  },
  {
    name: 'toggl_create_time_entry',
    description:
      'Manually log a completed time entry. Use for requests like "log 2h on Design yesterday". ' +
      'Resolve project name to project_id first using toggl_list_projects if a project is mentioned.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What you worked on',
        },
        duration_minutes: {
          type: 'number',
          description: 'How long in minutes (e.g. 90 for 1.5 hours)',
        },
        start: {
          type: 'string',
          description:
            'When the work started. Accepts YYYY-MM-DD (assumes 09:00 local) or full ISO 8601 datetime.',
        },
        project_id: {
          type: 'number',
          description: 'Project ID from toggl_list_projects (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply (optional)',
        },
        billable: {
          type: 'boolean',
          description: 'Mark entry as billable (default: false)',
        },
      },
      required: ['description', 'duration_minutes', 'start'],
    },
  },
  {
    name: 'toggl_get_current_timer',
    description:
      'Check if a Toggl timer is currently running. Returns the running entry with description, ' +
      'project, start time, and elapsed minutes — or {running: false} if nothing is active.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleGetMe() {
  const me = await togglFetch('/me');
  return {
    id: me.id,
    email: me.email,
    full_name: me.fullname,
    timezone: me.timezone,
    default_workspace_id: me.default_workspace_id,
  };
}

async function handleListProjects({ active_only = true } = {}) {
  const wid = await getWorkspaceId();
  const projects = await togglFetch(`/workspaces/${wid}/projects?active=${active_only}`);
  return (projects || []).map(p => ({
    id: p.id,
    name: p.name,
    active: p.active,
    color: p.color,
    billable: p.billable,
  }));
}

async function handleListTimeEntries({ start_date, end_date } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const from = start_date || today;
  const to = end_date || from;

  const startISO = `${from}T00:00:00Z`;
  const endISO = `${to}T23:59:59Z`;

  const entries = await togglFetch(
    `/me/time_entries?start_date=${encodeURIComponent(startISO)}&end_date=${encodeURIComponent(endISO)}`
  );

  return (entries || []).map(e => ({
    id: e.id,
    description: e.description || '(no description)',
    project_id: e.project_id ?? null,
    duration_seconds: e.duration,
    duration_minutes: e.duration > 0 ? Math.round(e.duration / 60) : null,
    start: e.start,
    stop: e.stop ?? null,
    tags: e.tags || [],
    billable: e.billable,
  }));
}

async function handleCreateTimeEntry({
  description,
  duration_minutes,
  start,
  project_id,
  tags = [],
  billable = false,
}) {
  const wid = await getWorkspaceId();

  // Accept bare date → treat as 09:00 local time expressed as UTC offset
  let startISO = start;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    startISO = `${start}T09:00:00Z`;
  }

  const durationSeconds = Math.round(duration_minutes * 60);

  const payload = {
    description,
    duration: durationSeconds,
    start: startISO,
    workspace_id: wid,
    created_with: 'claude-mcp-toggl',
    billable,
  };
  if (project_id) payload.project_id = project_id;
  if (tags.length) payload.tag_names = tags;

  const entry = await togglFetch(`/workspaces/${wid}/time_entries`, 'POST', payload);

  return {
    id: entry.id,
    description: entry.description,
    duration_seconds: entry.duration,
    duration_minutes: Math.round(entry.duration / 60),
    start: entry.start,
    stop: entry.stop,
    project_id: entry.project_id ?? null,
  };
}

async function handleGetCurrentTimer() {
  const entry = await togglFetch('/me/time_entries/current');
  if (!entry) return { running: false, entry: null };

  const elapsedMinutes = Math.round((Date.now() - new Date(entry.start).getTime()) / 60_000);

  return {
    running: true,
    entry: {
      id: entry.id,
      description: entry.description || '(no description)',
      project_id: entry.project_id ?? null,
      start: entry.start,
      elapsed_minutes: elapsedMinutes,
      tags: entry.tags || [],
    },
  };
}

// ─── MCP server wiring ───────────────────────────────────────────────────────

const server = new Server(
  { name: 'toggl', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case 'toggl_get_me':            result = await handleGetMe();                   break;
      case 'toggl_list_projects':     result = await handleListProjects(args);        break;
      case 'toggl_list_time_entries': result = await handleListTimeEntries(args);     break;
      case 'toggl_create_time_entry': result = await handleCreateTimeEntry(args);     break;
      case 'toggl_get_current_timer': result = await handleGetCurrentTimer();         break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

process.on('unhandledRejection', err => process.stderr.write(`toggl-mcp: unhandled rejection: ${err}\n`));
process.on('uncaughtException',  err => process.stderr.write(`toggl-mcp: uncaught exception: ${err}\n`));

const transport = new StdioServerTransport();
await server.connect(transport);

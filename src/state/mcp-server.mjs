import { createInterface } from 'node:readline';
import {
  trestle_decide,
  trestle_state_append,
  trestle_state_delete,
  trestle_state_health,
  trestle_state_lock_status,
  trestle_state_list,
  trestle_state_read,
  trestle_state_unlock,
  trestle_state_write,
} from './store.mjs';

const TOOL_HANDLERS = {
  trestle_state_read,
  trestle_state_write,
  trestle_state_append,
  trestle_state_delete,
  trestle_state_list,
  trestle_state_health,
  trestle_state_lock_status,
  trestle_state_unlock,
  trestle_decide,
};

const TOOL_DESCRIPTIONS = {
  trestle_state_read: 'Read one state value.',
  trestle_state_write: 'Atomically write one schema-validated state value.',
  trestle_state_append: 'Atomically append to a schema-validated array.',
  trestle_state_delete: 'Delete one mutable state value.',
  trestle_state_list: 'List state keys.',
  trestle_state_health: 'Report state server health and explicit roots.',
  trestle_state_lock_status: 'Inspect one per-key lock with token/pid/host/age and immutable inode+device identity.',
  trestle_state_unlock: 'Explicitly clear one stale per-key lock or recovery barrier. Provide expectedToken for a well-formed lock; for a malformed (tokenless) lock, authorize with expectedInode AND expectedDevice instead. Set recovery for an explicitly authorized recovery barrier. Live and valid tokened locks are never cleared without their token.',
  trestle_decide: 'Record a schema-validated decision.',
};

const STATE_TARGET_PROPERTIES = Object.freeze({
  scope: { type: 'string', enum: ['project', 'workstream'], description: 'State scope; defaults to workstream.' },
  namespace: { type: 'string', description: 'Registered mutable namespace.' },
  key: { type: 'string', description: 'Relative state key.' },
});

const TOOL_INPUT_SCHEMAS = {
  trestle_state_unlock: {
    type: 'object',
    properties: {
      ...STATE_TARGET_PROPERTIES,
      expectedToken: {
        type: 'string',
        description: 'Exact observed lock token. Required to clear a well-formed lock; omit only for tokenless malformed-lock recovery.',
      },
      expectedInode: {
        type: 'integer',
        minimum: 0,
        description: 'Exact observed lock inode. Required (with expectedDevice) when no expectedToken is supplied.',
      },
      expectedDevice: {
        type: 'integer',
        minimum: 0,
        description: 'Exact observed lock device id. Required (with expectedInode) when no expectedToken is supplied.',
      },
      recovery: {
        type: 'boolean',
        description: 'Explicitly recover the stale recovery barrier instead of the per-key lock.',
      },
    },
    required: ['namespace', 'key'],
    additionalProperties: false,
  },
  trestle_state_lock_status: {
    type: 'object',
    properties: { ...STATE_TARGET_PROPERTIES },
    required: ['namespace', 'key'],
    additionalProperties: false,
  },
};

export const TRESTLE_STATE_TOOLS = Object.freeze(Object.keys(TOOL_HANDLERS).map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: TOOL_INPUT_SCHEMAS[name] ?? {
    type: 'object',
    additionalProperties: true,
  },
})));

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, error) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32000,
      message: error.message,
      data: error.code ? { trestleCode: error.code, details: error.details } : undefined,
    },
  };
}

export function createTrestleMcpServer({ store, input = process.stdin, output = process.stdout } = {}) {
  if (!store) throw new TypeError('store is required; v1 runs one MCP server per workstream');
  let interfaceInstance;

  const handleRequest = async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return errorResponse(request?.id, new Error('invalid JSON-RPC 2.0 request'));
    }
    if (request.method === 'initialize') {
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-trestle-state', version: '1' },
      });
    }
    if (request.method === 'notifications/initialized') return undefined;
    if (request.method === 'tools/list') return response(request.id, { tools: TRESTLE_STATE_TOOLS });

    let name;
    let args;
    if (request.method === 'tools/call') {
      name = request.params?.name;
      args = request.params?.arguments ?? {};
    } else {
      name = request.method;
      args = request.params ?? {};
    }
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32601, message: `method not found: ${request.method}` },
      };
    }
    try {
      const value = await handler(store, args);
      if (request.id === undefined) return undefined;
      if (request.method === 'tools/call') {
        return response(request.id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
        });
      }
      return response(request.id, value);
    } catch (error) {
      if (request.id === undefined) return undefined;
      return errorResponse(request.id, error);
    }
  };

  const handleLine = async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return errorResponse(null, new Error('parse error'));
    }
    return handleRequest(request);
  };

  const start = () => {
    if (interfaceInstance) return interfaceInstance;
    interfaceInstance = createInterface({ input, crlfDelay: Infinity, terminal: false });
    interfaceInstance.on('line', async (line) => {
      if (!line.trim()) return;
      const result = await handleLine(line);
      if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
    });
    return interfaceInstance;
  };

  const close = () => interfaceInstance?.close();
  return { start, close, handleLine, handleRequest, tools: TRESTLE_STATE_TOOLS };
}

export function runTrestleMcpStdio(options) {
  const server = createTrestleMcpServer(options);
  server.start();
  return server;
}

export const createMcpStdioServer = createTrestleMcpServer;

'use strict';
/**
 * memory_mcp_server.js
 * --------------------
 * Servidor MCP para OpenClaw + Gemma 4.
 * Usa sql.js (WebAssembly) — sin compilación nativa.
 */

const readline = require('readline');
const { MemoryManager, DEFAULT_DB } = require('./memory_manager');

const TOOLS = [
  {
    name: 'memory_save',
    description: 'Guarda un recuerdo persistente en SQL. Úsalo cuando el usuario mencione preferencias, hechos importantes, tareas, o información que deba recordarse entre sesiones.',
    inputSchema: {
      type: 'object',
      properties: {
        content:    { type: 'string', description: 'Texto del recuerdo' },
        type:       { type: 'string', enum: ['fact','preference','task','note','summary'], default: 'fact' },
        scope:      { type: 'string', enum: ['user','session'], default: 'user' },
        importance: { type: 'number', default: 0.5 },
        tags:       { type: 'array', items: { type: 'string' }, default: [] },
        sessionId:  { type: 'string' }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_search',
    description: 'Busca recuerdos por texto.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 },
        scope: { type: 'string', enum: ['user','session'] }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_recall',
    description: 'Recupera recuerdos recientes por importancia. Úsalo al inicio de conversación.',
    inputSchema: {
      type: 'object',
      properties: {
        scope:         { type: 'string', enum: ['user','session'], default: 'user' },
        type:          { type: 'string', enum: ['fact','preference','task','note','summary'] },
        limit:         { type: 'number', default: 20 },
        minImportance: { type: 'number', default: 0.0 }
      }
    }
  },
  {
    name: 'memory_forget',
    description: 'Elimina un recuerdo por ID.',
    inputSchema: {
      type: 'object',
      properties: { memoryId: { type: 'number' } },
      required: ['memoryId']
    }
  },
  {
    name: 'memory_context',
    description: 'Genera un bloque de contexto con recuerdos relevantes para inyectar al prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        query:           { type: 'string' },
        sessionId:       { type: 'string' },
        maxTokensApprox: { type: 'number', default: 1500 }
      }
    }
  }
];

function handleTool(mem, name, args) {
  switch (name) {
    case 'memory_save': {
      const id = mem.save(args.content, {
        type: args.type || 'fact',
        scope: args.scope || 'user',
        sessionId: args.sessionId || null,
        importance: args.importance ?? 0.5,
        tags: args.tags || []
      });
      return { success: true, memoryId: id, message: `Recuerdo guardado con ID ${id}` };
    }
    case 'memory_search': {
      const results = mem.search(args.query, { limit: args.limit || 10, scope: args.scope || null });
      return { count: results.length, memories: results.map(m => ({ id: m.id, type: m.type, scope: m.scope, content: m.content, importance: m.importance, createdAt: m.created_at })) };
    }
    case 'memory_recall': {
      const results = mem.recall({ scope: args.scope || 'user', type: args.type || null, limit: args.limit || 20, minImportance: args.minImportance || 0.0 });
      return { count: results.length, memories: results.map(m => ({ id: m.id, type: m.type, scope: m.scope, content: m.content, importance: m.importance, createdAt: m.created_at })) };
    }
    case 'memory_forget': {
      mem.forget(args.memoryId);
      return { success: true, message: `Recuerdo ${args.memoryId} eliminado` };
    }
    case 'memory_context': {
      const block = mem.buildContextBlock(args.query || null, { sessionId: args.sessionId || null, maxTokensApprox: args.maxTokensApprox || 1500 });
      return { contextBlock: block, empty: block.length === 0 };
    }
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
}

async function main() {
  // Inicializar memoria ANTES de abrir readline
  let mem;
  try {
    mem = await MemoryManager.create(process.env.MEMORY_DB_PATH || DEFAULT_DB);
  } catch (err) {
    process.stderr.write('Error iniciando MemoryManager: ' + err.message + '\n');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'memory-sql', version: '1.0.0' }
          }
        });
      } else if (method === 'notifications/initialized') {
        // sin respuesta
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const result = handleTool(mem, params.name, params.arguments || {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado: ${method}` } });
      }
    } catch (err) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
    }
  });

  rl.on('close', () => { mem.close(); process.exit(0); });
  process.on('SIGINT', () => { mem.close(); process.exit(0); });
  process.on('SIGTERM', () => { mem.close(); process.exit(0); });
}

main().catch(err => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});

// watcher.js — tail incremental dos logs JSONL do Claude Code.
// Emite: 'entry' (obj, ctx), 'ready', 'warn' (msg).
// ctx = { file, catchup: boolean, meta: object|null }
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

const CATCHUP_BYTES = 256 * 1024;          // só o rabo de cada arquivo no início
const CATCHUP_MAX_AGE_MS = 6 * 3600 * 1000; // só arquivos mexidos nas últimas 6h
const MAX_LINE_BYTES = 8 * 1024 * 1024;     // linhas maiores (imagens base64) são descartadas

export class Watcher extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.files = new Map();   // file -> { offset, pending: Buffer, reading, again }
    this.ready = false;
    this.inflight = 0;
    this.flushed = false;
    this.catchupBuf = [];     // entradas do catch-up, ordenadas por timestamp no fim
    this.fsw = null;
  }

  start() {
    if (!fs.existsSync(this.dir)) {
      this.emit('warn', `Diretório não existe: ${this.dir}`);
      this.emit('ready');
      return false;
    }
    this.fsw = chokidar.watch(this.dir, {
      persistent: true,
      ignoreInitial: false,
      // chokidar v4 não tem globs: filtra por extensão aqui
      ignored: (p, stats) => !!stats && stats.isFile() && !p.endsWith('.jsonl'),
    });
    this.fsw.on('add', (f, st) => this.#onFile(f, st, true));
    this.fsw.on('change', (f, st) => this.#onFile(f, st, false));
    this.fsw.on('unlink', (f) => this.files.delete(f));
    this.fsw.on('error', (e) => this.emit('warn', `watcher: ${e?.message || e}`));
    this.fsw.on('ready', () => { this.ready = true; this.#maybeFlush(); });
    return true;
  }

  // Só despeja o catch-up quando o scan acabou E as leituras iniciais terminaram
  #maybeFlush() {
    if (this.flushed || !this.ready || this.inflight > 0) return;
    this.flushed = true;
    this.catchupBuf.sort((a, b) => a.ts - b.ts); // ordem cronológica entre arquivos
    for (const it of this.catchupBuf) this.#emitEntry(it.obj, it.ctx);
    this.catchupBuf = [];
    this.emit('ready');
  }

  async close() {
    try { await this.fsw?.close(); } catch { /* ignora */ }
  }

  #onFile(file, stats, isAdd) {
    if (!file.endsWith('.jsonl')) return;
    let st = this.files.get(file);
    if (!st) {
      st = { offset: 0, pending: Buffer.alloc(0), reading: false, again: false };
      this.files.set(file, st);
      if (isAdd) {
        if (!this.flushed) {
          // arquivo existente no início: catch-up do rabo se for recente
          let size = stats?.size, mtime = stats?.mtimeMs;
          try { if (size == null) { const s = fs.statSync(file); size = s.size; mtime = s.mtimeMs; } } catch { return; }
          const recent = Date.now() - mtime < CATCHUP_MAX_AGE_MS;
          st.offset = size;
          if (recent && size > 0) {
            const start = Math.max(0, size - CATCHUP_BYTES);
            this.#readRange(file, st, start, size, true, start > 0);
          }
          return;
        }
        // arquivo novo depois do início: lê tudo desde 0
      }
    }
    this.#pump(file, st);
  }

  // Lê o delta [offset, size) garantindo uma leitura por vez por arquivo.
  #pump(file, st) {
    if (st.reading) { st.again = true; return; }
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < st.offset) { st.offset = 0; st.pending = Buffer.alloc(0); } // truncado/recriado
    if (size === st.offset) return;
    const start = st.offset;
    st.offset = size;
    this.#readRange(file, st, start, size, false, false);
  }

  #readRange(file, st, start, size, catchup, dropFirst) {
    st.reading = true;
    this.inflight++;
    const chunks = [];
    const stream = fs.createReadStream(file, { start, end: size - 1 });
    const finish = () => {
      st.reading = false;
      this.inflight--;
      this.#maybeFlush();
      if (st.again) { st.again = false; this.#pump(file, st); }
    };
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', () => finish());
    stream.on('end', () => {
      try {
        let buf = Buffer.concat([st.pending, ...chunks]);
        let nl = buf.lastIndexOf(0x0a);
        if (nl === -1) {
          st.pending = buf.length > MAX_LINE_BYTES ? Buffer.alloc(0) : buf;
        } else {
          st.pending = buf.subarray(nl + 1);
          if (st.pending.length > MAX_LINE_BYTES) st.pending = Buffer.alloc(0);
          const text = buf.subarray(0, nl).toString('utf8');
          let lines = text.split('\n');
          if (dropFirst) lines.shift(); // primeira linha do catch-up pode estar cortada
          this.#handleLines(file, lines, catchup);
        }
      } catch (e) {
        this.emit('warn', `leitura ${path.basename(file)}: ${e.message}`);
      }
      finish();
    });
  }

  #handleLines(file, lines, catchup) {
    const meta = this.#metaFor(file);
    const ctx = { file, catchup, meta };
    for (const line of lines) {
      if (!line || line.length > MAX_LINE_BYTES) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; } // linha inválida = ignora
      if (!obj || typeof obj !== 'object') continue;
      if (catchup && !this.flushed) {
        this.catchupBuf.push({ ts: Date.parse(obj.timestamp) || 0, obj, ctx });
      } else {
        this.#emitEntry(obj, ctx);
      }
    }
  }

  #emitEntry(obj, ctx) {
    try { this.emit('entry', obj, ctx); } catch (e) { this.emit('warn', `entry: ${e.message}`); }
  }

  // Subagentes têm um agent-<id>.meta.json ao lado (description, agentType, toolUseId, model)
  #metaFor(file) {
    const base = path.basename(file);
    if (!base.startsWith('agent-')) return null;
    try {
      return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch { return null; }
  }
}

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SCRIPT = path.join(__dirname, 'test', 'tls_worker.py')

if (!fs.existsSync(WORKER_SCRIPT)) {
  console.error(`Worker not found at ${WORKER_SCRIPT}`)
  process.exit(1)
}

export class CfClient {
  constructor(workerCount = 4) {
    this.workers = []
    this.pending = new Map()
    this.counter = 0

    if (!fs.existsSync(WORKER_SCRIPT)) {
      throw new Error(`Worker script not found at ${WORKER_SCRIPT}`)
    }

    for (let i = 0; i < workerCount; i++) this._spawn()
  }

  _spawn() {
    const proc = spawn('python', [WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    proc.stdout.on('data', c => {
      buf += c.toString()
      const ls = buf.split('\n')
      buf = ls.pop()
      for (const l of ls) {
        if (!l.trim()) continue
        try {
          const r = JSON.parse(l)
          const e = this.pending.get(r.id)
          if (e) { this.pending.delete(r.id); e.resolve(r) }
        } catch (_) {}
      }
    })
    proc.stderr.on('data', () => {})
    proc.on('exit', () => setTimeout(() => this._spawn(), 1000))
    this.workers.push(proc)
  }

  request(url, body, opts = {}) {
    const id = Date.now() + Math.random()
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res })
      const msg = JSON.stringify({
        id, url, body, method: opts.method || 'POST',
        proxy: opts.proxy || null,
        headers: opts.headers || {},
        timeout: opts.timeout || 30
      }) + '\n'
      this.workers[this.counter++ % this.workers.length].stdin.write(msg)
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('Timeout')) }
      }, (opts.timeout || 30) * 1000 + 5000)
    })
  }

  signup(email, password, opts = {}) {
    return this.request('https://2no.pl/', { id: 103, query: { email, password } }, opts)
  }

  login(email, password, opts = {}) {
    return this.request('https://2no.pl/', { id: 101, query: { email, password } }, opts)
  }

  confirm(email, token, opts = {}) {
    return this.request('https://2no.pl/', { id: 104, query: { email, token } }, opts)
  }

  api(token, body, opts = {}) {
    return this.request('https://2no.pl/', body, { ...opts, headers: { ...opts.headers, 'x-auth-token': token } })
  }

  close() { for (const w of this.workers) w.kill() }
}

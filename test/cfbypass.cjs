const { spawn } = require('child_process');
const path = require('path');

class CfClient {
  constructor(pyScript, n = 4) {
    this.workers = [];
    this.pending = new Map();
    this.counter = 0;
    this.pyScript = pyScript;
    for (let i = 0; i < n; i++) this._spawn();
  }

  _spawn() {
    const proc = spawn('python', [this.pyScript], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.on('data', c => {
      buf += c.toString();
      const ls = buf.split('\n');
      buf = ls.pop();
      for (const l of ls) {
        if (!l.trim()) continue;
        try {
          const r = JSON.parse(l);
          const e = this.pending.get(r.id);
          if (e) { this.pending.delete(r.id); e.resolve(r); }
        } catch (_) {}
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('exit', () => setTimeout(() => this._spawn(), 1000));
    this.workers.push(proc);
  }

  request(url, body, opts = {}) {
    const id = Date.now() + Math.random();
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res });
      const msg = JSON.stringify({
        id, url, body,
        proxy: opts.proxy || null,
        headers: opts.headers || {},
        timeout: opts.timeout || 30
      }) + '\n';
      this.workers[this.counter++ % this.workers.length].stdin.write(msg);
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('Timeout')); }
      }, (opts.timeout || 30) * 1000 + 5000);
    });
  }

  signup(email, password, opts = {}) {
    return this.request('https://2no.pl/', { id: 103, query: { email, password } }, opts);
  }

  login(email, password, opts = {}) {
    return this.request('https://2no.pl/', { id: 101, query: { email, password } }, opts);
  }

  close() { for (const w of this.workers) w.kill(); }
}

async function main() {
  const client = new CfClient(path.join(__dirname, 'tls_worker.py'), 2);

  console.log('=== Signup ===');
  console.log(await client.signup('gweber@kilolabs.space', 'Abuhider123@@@'));

  console.log('\n=== Login ===');
  console.log(await client.login('gweber@kilolabs.space', 'Abuhider123@@@'));

  client.close();
}

if (require.main === module) main();
module.exports = { CfClient };

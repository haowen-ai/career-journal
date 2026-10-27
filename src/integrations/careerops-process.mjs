import { spawn } from 'node:child_process';

const active = new Set();

// Each wrapper owns its child's group. Bridge signal handlers also stop nested groups.
export function executeCareerOpsProcess({ command, args, cwd, env, stdin, timeoutMs, maxBytes = 50_000_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32',
      stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let bytes = 0; let failure; let stopping; let settled = false;
    let timer;
    const signalTree = (signal) => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
        } else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') { try { child.kill(signal); } catch { /* already gone */ } } }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(handle);
      if (error) reject(error); else resolve(result);
    };
    const stop = (message, graceMs = 400) => {
      if (stopping) return stopping;
      failure = new Error(message);
      clearTimeout(timer);
      signalTree('SIGTERM');
      stopping = new Promise((done) => setTimeout(() => {
        // Do this even if the parent exited: descendants can still own its group and pipes.
        signalTree('SIGKILL');
        child.stdout.destroy(); child.stderr.destroy(); child.stdin?.destroy();
        finish(failure);
        done();
      }, graceMs));
      return stopping;
    };
    const handle = { stop };
    active.add(handle);
    timer = setTimeout(() => stop(`CareerOps request timed out after ${timeoutMs}ms`), timeoutMs);
    const append = (chunk, stream) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stop('CareerOps output exceeds byte limit'); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    child.once('error', (error) => { if (!failure) finish(error); });
    child.once('close', (exitCode, signal) => {
      if (!failure) finish(null, { exitCode, signal, stdout, stderr });
    });
    if (child.stdin) {
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error.message); });
      child.stdin.end(stdin);
    }
  });
}

// A raw worker may own a detached legacy scan group. Propagate TERM before exiting,
// with a shorter grace period than the caller so its KILL timer can finish.
export function installCareerOpsShutdown() {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    Promise.all([...active].map((child) => child.stop(`CareerOps stopped (${signal})`, 100)))
      .finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130));
  });
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  try { return (await execFileAsync('git', args, { cwd: root })).stdout.trim(); }
  catch (error) { throw new Error(`Git inspection failed: ${error.stderr?.trim() || error.message}`); }
}

export async function inspectUpdate(root, version, dependencies = {}) {
  const runGit = dependencies.git ?? ((args) => git(root, args));
  const [head, branch, status, remote] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['branch', '--show-current']),
    runGit(['status', '--porcelain']),
    runGit(['remote', 'get-url', 'origin']).catch(() => ''),
  ]);
  return {
    version,
    head,
    branch: branch || null,
    clean: status === '',
    remote: remote || null,
    updateApplied: false,
    next: status === '' ? 'Fetch a tagged release, create a backup, then run migrate --dry-run.' : 'Commit or stash local changes before updating.',
  };
}

export async function updateCommand(parsed, io, runtime) {
  if (parsed.options.check !== true && parsed.subcommand !== 'check') throw new Error('Usage: career-journal update --check');
  io.out(JSON.stringify(await inspectUpdate(runtime.root, runtime.version), null, 2));
  return 0;
}

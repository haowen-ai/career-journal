export function memoryIO() {
  const state = { stdout: '', stderr: '' };
  return {
    get stdout() { return state.stdout; },
    get stderr() { return state.stderr; },
    out(value) { state.stdout += `${value}\n`; },
    err(value) { state.stderr += `${value}\n`; },
  };
}


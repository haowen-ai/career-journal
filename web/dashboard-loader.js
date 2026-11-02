// One generation covers summary and page together. A slow earlier request may
// finish after a new filter, but can never publish either its data or error.
export function createDashboardLoader({ fetchJson, onLoading, onData, onError }) {
  let generation = 0;
  const load = async function load({ group = 'all', query = '', sort = 'deadline', fit = 'all', page = 1, pageSize = 50 } = {}) {
    const current = ++generation;
    onLoading(true);
    try {
      const params = new URLSearchParams({ group, query, sort, fit, page, pageSize });
      const [summary, result] = await Promise.all([
        fetchJson('/api/dashboard/summary'), fetchJson(`/api/dashboard/page?${params}`),
      ]);
      if (current === generation) onData({ summary, result });
    } catch (error) {
      if (current === generation) onError(error);
    } finally {
      if (current === generation) onLoading(false);
    }
  };
  load.invalidate = () => { generation += 1; };
  return load;
}

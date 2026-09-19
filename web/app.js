const state = { applications: [] };
const search = document.querySelector('#search');
const status = document.querySelector('#status');
const grid = document.querySelector('#applications');
const empty = document.querySelector('#empty');
const summary = document.querySelector('#summary');
const template = document.querySelector('#application-template');

function render() {
  const query = search.value.trim().toLowerCase();
  const selectedStatus = status.value;
  const visible = state.applications.filter((item) => {
    const matchesText = `${item.company} ${item.role}`.toLowerCase().includes(query);
    return matchesText && (!selectedStatus || item.status === selectedStatus);
  });
  grid.replaceChildren(...visible.map((item) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.company').textContent = item.company;
    node.querySelector('.role').textContent = item.role;
    node.querySelector('.status').textContent = item.status;
    node.querySelector('.stage').textContent = item.stage || 'No stage recorded';
    node.querySelector('.applied').textContent = item.appliedAt || 'Date not provided';
    node.querySelector('.application-id').textContent = item.id;
    return node;
  }));
  summary.textContent = `${visible.length} of ${state.applications.length} applications`;
  empty.hidden = visible.length !== 0;
}

async function load() {
  const response = await fetch('/api/applications');
  if (!response.ok) throw new Error('Unable to load applications');
  state.applications = await response.json();
  const values = [...new Set(state.applications.map((item) => item.status))].sort();
  status.replaceChildren(new Option('All statuses', ''), ...values.map((value) => new Option(value, value)));
  render();
}

search.addEventListener('input', render);
status.addEventListener('change', render);
document.querySelector('#refresh').addEventListener('click', () => load().catch(showError));
const showError = (error) => { summary.textContent = error.message; };
load().catch(showError);


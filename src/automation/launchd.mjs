const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderLaunchd(task, runtime) {
  const [hour, minute] = task.schedule.split(':').map(Number);
  const label = task.id.startsWith('jobops-') ? `io.job-search-ops.${task.type}` : `io.career-journal.${task.type}`;
  const args = [runtime.node, runtime.cli, 'automation', 'run', '--id', task.id, '--home', runtime.home];
  return {
    kind: 'launchd',
    fileName: `${label}.plist`,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>TZ</key><string>${xml(task.timezone)}</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
<key>RunAtLoad</key><false/>
</dict></plist>
`,
  };
}

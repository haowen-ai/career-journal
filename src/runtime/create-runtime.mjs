import { setupCommand } from '../commands/setup.mjs';
import { doctorCommand } from '../commands/doctor.mjs';
import { applicationCommand } from '../commands/application.mjs';
import { eventCommand } from '../commands/event.mjs';
import { artifactCommand } from '../commands/artifact.mjs';
import { exportCommand } from '../commands/export.mjs';
import { startCommand } from '../commands/start.mjs';
import { automationCommand } from '../commands/automation.mjs';

export function createRuntime({ root, version }) {
  return {
    root,
    version,
    commands: new Map([
      ['setup', setupCommand],
      ['doctor', doctorCommand],
      ['application', applicationCommand],
      ['event', eventCommand],
      ['artifact', artifactCommand],
      ['export', exportCommand],
      ['start', startCommand],
      ['automation', automationCommand],
    ]),
  };
}

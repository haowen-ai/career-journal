import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../src/commands/setup.mjs';
import { openHomeDatabase } from '../src/runtime/home.mjs';
import { createApplication } from '../src/commands/application.mjs';
import { recordEvent } from '../src/domain/events.mjs';
import { archiveArtifact } from '../src/domain/artifacts.mjs';

function assertPreviewHome(value) {
  const home = path.resolve(value);
  const temporaryRoots = new Set([path.resolve(os.tmpdir()), path.resolve('/tmp'), path.resolve('/private/tmp')]);
  if (!temporaryRoots.has(path.dirname(home)) || !path.basename(home).startsWith('career-journal-preview-')) {
    throw new Error(`Preview homes must be direct children of a temporary directory and named career-journal-preview-*`);
  }
  return home;
}

function parseArgs(argv) {
  const index = argv.indexOf('--home');
  if (index === -1 || !argv[index + 1]) throw new Error('Usage: node scripts/seed-dashboard-preview.mjs --home <temporary-directory>');
  const localeIndex = argv.indexOf('--locale');
  const locale = localeIndex === -1 ? 'zh-CN' : argv[localeIndex + 1];
  if (!['en', 'zh-CN'].includes(locale)) throw new Error('Preview locale must be en or zh-CN');
  return { home: assertPreviewHome(argv[index + 1]), locale };
}

export async function seedDashboardPreview(home, { locale = 'zh-CN' } = {}) {
  home = assertPreviewHome(home);
  if (!['en', 'zh-CN'].includes(locale)) throw new Error('Preview locale must be en or zh-CN');
  await rm(home, { recursive: true, force: true });
  await setup(home, { timezone: 'UTC', email: { mode: 'skip' } });
  const context = await openHomeDatabase(home);
  const sourceDir = `${home}-source-artifacts`;

  try {
    const applications = [
      { company: 'Apple · Demo', role: 'AI/ML Engineer Intern', externalId: 'DEMO-APL-001', appliedAt: '2026-09-08T15:00:00Z' },
      { company: 'Google · Demo', role: 'Data Scientist Intern', externalId: 'DEMO-GOO-002', appliedAt: '2026-09-07T15:00:00Z' },
      { company: 'Microsoft · Demo', role: 'AI Product Manager Intern', externalId: 'DEMO-MSF-003', appliedAt: '2026-09-06T15:00:00Z' },
      { company: 'NVIDIA · Demo', role: 'Generative AI Solutions Engineer Intern', externalId: 'DEMO-NVDA-004', appliedAt: '2026-09-05T15:00:00Z' },
      { company: 'Amazon · Demo', role: 'Applied Scientist Intern', externalId: 'DEMO-AMZ-005', appliedAt: '2026-09-04T15:00:00Z' },
      { company: 'Meta · Demo', role: 'Machine Learning Engineer Intern', externalId: 'DEMO-META-006', appliedAt: '2026-09-03T15:00:00Z' },
      { company: 'Tesla · Demo', role: 'AI Product Intern', externalId: 'DEMO-TSLA-007', status: 'prepared', appliedAt: null },
    ];

    const records = new Map();
    for (const [offset, item] of applications.entries()) {
      const createdAt = new Date(Date.parse('2026-09-08T15:00:00Z') - offset * 86_400_000).toISOString();
      const record = createApplication(context.db, {
        company: item.company,
        role: item.role,
        externalId: item.externalId,
        status: item.status ?? 'applied',
        appliedAt: item.appliedAt,
      }, createdAt);
      records.set(item.company, record);
    }

    const addEvent = (company, id, type, title, note, recordedAt, statusAfter) => recordEvent(context.db, {
      id,
      applicationId: records.get(company).id,
      type,
      occurredAt: recordedAt,
      observedAt: recordedAt,
      recordedAt,
      title,
      note,
      source: { kind: 'fixture', fixture: 'synthetic-big-company-demo' },
      statusAfter,
    });

    const eventCopy = locale === 'en' ? {
      interview: ['Technical interview scheduled', '[Synthetic demo] Interview time recorded for the AI applications team'],
      offer: ['Offer received', '[Synthetic demo] Hiring decision recorded'],
      accepted: ['Offer accepted', '[Synthetic demo] Start date confirmed'],
      assessment: ['Online assessment received', '[Synthetic demo] Assessment deadline recorded'],
      received: ['Application received', '[Synthetic demo] Careers site confirmed receipt'],
      closed: ['Application closed', '[Synthetic demo] Application did not advance'],
      submitted: ['Application submitted', '[Synthetic demo] Submission confirmed'],
      materials: ['Application materials ready', '[Synthetic demo] Resume and cover letter awaiting review'],
    } : {
      interview: ['技术面试已安排', '[合成演示] 已记录 AI 应用团队面试时间'],
      offer: ['收到录用通知', '[合成演示] 已记录录用决定'],
      accepted: ['已接受录用', '[合成演示] 已确认入职日期'],
      assessment: ['收到在线测评', '[合成演示] 已记录测评截止时间'],
      received: ['已收到申请', '[合成演示] 招聘网站已确认收件'],
      closed: ['申请已结束', '[合成演示] 该申请未进入下一阶段'],
      submitted: ['申请已提交', '[合成演示] 已确认提交成功'],
      materials: ['申请材料已准备', '[合成演示] 简历与求职信等待审核'],
    };

    addEvent('Apple · Demo', 'demo-apple-interview', 'interview_scheduled', ...eventCopy.interview, '2026-09-18T15:10:00Z', 'interview');
    addEvent('Google · Demo', 'demo-google-offer', 'offer_received', ...eventCopy.offer, '2026-09-18T14:30:00Z', 'offer');
    addEvent('Google · Demo', 'demo-google-accepted', 'offer_accepted', ...eventCopy.accepted, '2026-09-18T14:45:00Z', 'accepted');
    addEvent('Microsoft · Demo', 'demo-microsoft-assessment', 'assessment_received', ...eventCopy.assessment, '2026-09-18T14:15:00Z', 'assessment');
    addEvent('NVIDIA · Demo', 'demo-nvidia-applied', 'application_submitted', ...eventCopy.received, '2026-09-17T16:20:00Z', 'applied');
    addEvent('Amazon · Demo', 'demo-amazon-closed', 'application_closed', ...eventCopy.closed, '2026-09-16T18:00:00Z', 'rejected');
    addEvent('Meta · Demo', 'demo-meta-applied', 'application_submitted', ...eventCopy.submitted, '2026-09-15T17:00:00Z', 'applied');
    addEvent('Tesla · Demo', 'demo-tesla-ready', 'materials_prepared', ...eventCopy.materials, '2026-09-14T16:00:00Z', 'prepared');

    await rm(sourceDir, { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    for (const item of [
      { company: 'Apple · Demo', name: 'apple-ai-ml-demo-resume.pdf', lifecycle: 'submitted', time: '2026-09-08T15:05:00Z' },
      { company: 'Google · Demo', name: 'google-data-science-demo-resume.pdf', lifecycle: 'submitted', time: '2026-09-07T15:05:00Z' },
      { company: 'Microsoft · Demo', name: 'microsoft-ai-product-demo-resume.pdf', lifecycle: 'submitted', time: '2026-09-06T15:05:00Z' },
      { company: 'Tesla · Demo', name: 'tesla-ai-product-demo-resume.pdf', lifecycle: 'draft', time: '2026-09-14T15:55:00Z' },
    ]) {
      const file = path.join(sourceDir, item.name);
      await writeFile(file, `%PDF-1.4\n% Synthetic CAREER JOURNAL demo artifact for ${item.company}\n`);
      await archiveArtifact(context.db, {
        applicationId: records.get(item.company).id,
        kind: 'resume',
        lifecycle: item.lifecycle,
        submittedConfirmed: item.lifecycle === 'submitted',
        submittedAt: item.lifecycle === 'submitted' ? item.time : null,
        recordedAt: item.time,
        filePath: file,
        storageRoot: context.artifactRoot,
        verification: 'passed',
        metadata: { source: 'synthetic-big-company-demo' },
      });
    }

    return { home, applications: applications.length };
  } finally {
    context.db.close();
    await rm(sourceDir, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { home, locale } = parseArgs(process.argv.slice(2));
  const result = await seedDashboardPreview(home, { locale });
  console.log(JSON.stringify(result));
}

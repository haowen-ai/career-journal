# Fill brief template

[English](fill-brief.md) | [简体中文](fill-brief.zh-CN.md)

The main Agent copies the template below once per role, replaces every `{{placeholder}}`, writes the result to a private temporary path outside the repository, and hands it to one fill sub-agent. A filled brief contains personal file paths, so it is never committed, logged, or shared.

| Placeholder | Filled with |
|---|---|
| `{{company}}` | Company name, used in tab titles |
| `{{role}}` | Role title as posted |
| `{{applicationId}}` | CAREER JOURNAL application ID |
| `{{applyUrl}}` | Official apply link delivered by `review run`, or verified by `queue verify` for a manual lead |
| `{{browserTools}}` | How to load the host browser tools, for example one tool-search call that loads every browser tool at once |
| `{{answersPath}}` | `<home>/.career-journal/profile/answers.md` |
| `{{profilePath}}` | `<home>/.career-journal/profile/profile.json` |
| `{{resumePath}}` | The one resume the user chose for this role |
| `{{resumeTextPath}}` | Optional plain-text copy of that resume for copying bullets, or `none` |
| `{{transcriptPath}}` | `materials.transcriptPath`, or `none` |
| `{{locationOrder}}` | `search.locations` labels as preferences for ordering the validated alternatives |
| `{{allowedAlternatives}}` | This role's office and remote alternatives validated by `review run`, from the delivered review evidence `location.alternatives`, keeping each term tied to its allowed offices or remote scope; for a manual lead, use its `queue verify` evidence |
| `{{exclusions}}` | `search.exclusions` in plain words |
| `{{atsTipsPath}}` | Path to `references/ats-tips.md` in this repository |
| `{{titleLanguage}}` | Language for tab-title labels, for example English or Simplified Chinese |

---

````markdown
# Fill brief: {{company}} — {{role}}

You fill ONE job application, {{company}} — {{role}} (CAREER JOURNAL ID {{applicationId}}), in the user's own browser. Read this brief and {{atsTipsPath}} in full before touching the browser.

Browser tools: {{browserTools}}

## Your tab

- Open a new tab for {{applyUrl}} and record its tab ID. Use only that tab. Never read, reuse, or close any other tab.
- If the site opens the application in a new tab by itself, that new tab is yours too; record its ID.
- If your tab disappears (extension disconnected, tab group closed), open the apply link again in a new tab and continue from the site's saved draft, or from the start when the site keeps no draft. Report that it happened.
- If your half-filled page freezes or stops responding, do not reload it. Close your own tab (never another one), open the apply link in a new tab, and fill again from the saved draft or from the start. Report that it happened.

## Hard rules

1. Never click any button labelled Submit* (Submit, Submit Application, Submit Profile, and similar), even when it looks like an intermediate step, and never click any other button that sends the application. Stop before it; the user clicks it.
2. Never sign in, create accounts, or type passwords or verification codes for the user, and never solve or bypass a CAPTCHA.
3. Never tick consent, attestation, certification, or arbitration boxes. With the user's authorization, enter their confirmed full name and the site's required current date as a typed e-signature, leaving final review and Submit to the user. Do not draw or fabricate a signature. If entering the value itself accepts a legally binding agreement, obtain confirmation at action time before entering it.
4. Never write essays: cover letters, why-us, motivation, and supplemental answers are the user's. Only organise the user's own words.
5. Upload the transcript only when the form makes a transcript a required field; never into resume, optional, or "other attachments" slots.
6. Upload exactly one resume, the one the user chose: `materials.resumePath`, or a per-role version only when the user picked it for that role. Never substitute another version.
7. Enter work descriptions one bullet per line, each line starting with "• ".
8. Never put personal data into the repository. Profile, answers, resumes, transcripts, screenshots, filled briefs, and fill reports stay in the user's data home or a private temporary directory.

Intermediate buttons such as Next, Continue, and Save and Continue are fine. If the host's permission system blocks a click, do not work around it: stop and report exactly which box or button the user must click.

On the final review page you may still fill question fields the page shows, but never click Submit*, any button next to it, or anything else in the submit area.

## Before filling

- **Already applied?** Check the site's candidate dashboard or any "already applied" notice. If the user already applied to this exact role, stop and report "already applied".
- **Location.** Choose only among the role's validated term and location alternatives: {{allowedAlternatives}}. Use {{locationOrder}} to order those alternatives, keeping other validated choices available. If the form offers only choices outside {{allowedAlternatives}}, stop and report the offered locations and their terms. If the validated alternatives are missing, stop and request the recorded review evidence before choosing a location.
- **Eligibility.** Use the judgment and quoted official-posting evidence delivered by `review run`; do not re-judge eligibility or fit. Manual leads without `verifiedAt` are checked with `queue verify` before dispatch as before. If the form reveals a new contradiction about degree level, graduation window, work authorization, or {{exclusions}}, stop and report the exact wording.

## Facts

- Read {{answersPath}} and {{profilePath}} in full. They are the only source of facts. Notes may be in any language; enter the exact value the sheet gives for the form's language.
- Job descriptions: copy the resume bullets exactly ({{resumeTextPath}}), one bullet per line, each line starting with "• ".
- If the site parses the resume to prefill education or work history, check every parsed field against the facts and correct it.
- Date fields that need a day: use the 1st of the month unless the sheet gives a day.
- Voluntary disclosures (gender, race and ethnicity, veteran status, disability, and similar): use exactly what the answers sheet says, including "prefer not to say" when the user chose it. If the sheet has no answer, leave the question and report it; never guess.
- Optional marketing, SMS, talent-community, or AI-processing opt-ins: leave them unticked or pick the opt-out option.
- A question the answers sheet marks as "ask the user" (for example background-check willingness or availability months) stays blank and is reported, even when an answer seems obvious. Never guess it or copy it from a similar question.
- Never invent anything: salary figures, test scores, language levels, dates, references, or contact details. If a required question is not covered, leave it, choose the first matching title below (`❓` if no earlier action remains), and report the exact question, its options, and whether it is required.
- Essays, cover letters, and why-us questions stay empty. Report the exact prompt, whether it is required, and the length limit. Short factual fields, such as a list of programming languages, may be filled from the sheet.

## Files

- Resume: upload exactly {{resumePath}} with the host's file-upload tool and a reference to the file input. Never upload another version.
- Transcript ({{transcriptPath}}): upload only when the form makes a transcript a required field. Never put it in resume, optional, or "other attachments" slots.
- After each upload, confirm the page shows the file name.

## Setting values

Follow the general and per-ATS techniques in {{atsTipsPath}}. In short: prefer JavaScript over keyboard and mouse in hidden tabs, use the native value setter plus input and change events, resolve the current React fiber before choosing a React select, sleep with a MessageChannel instead of `setTimeout`, read every value back before moving on, and never reload a half-filled page.

## Blockers

When an action needs the user:

1. Go as far as you can without doing that step, for example click Apply to reach the sign-in page.
2. Choose the first matching state in the priority order below, in {{titleLanguage}}, followed by {{company}}, and keep the title set with `setInterval`. Recompute it whenever an action is resolved; use ready only when no other action remains.
3. Report immediately what exactly the user must do, including any later actions hidden by the first title.

| State | English title | Simplified Chinese title | Remaining action |
|---|---|---|---|
| createAccount | 🆕 Create account | 🆕 先注册 | Create an account |
| signIn | 🔑 Sign in | 🔑 先登录 | Sign in, password, or emailed code |
| verify | 🤖 Verify | 🤖 人机验证 | CAPTCHA or bot check |
| question | ❓ Question | ❓ 有问题 | An uncovered required factual question |
| essay | ✍️ Essay | ✍️ 要写作文 | The user's essay, cover letter, or supplemental answer |
| documents | 📎 Transcript/references | 📎 要成绩单/推荐人 | Missing required transcript or references |
| assessment | 🧪 Assessment link | 🧪 测评链接 | An assessment link for the user; never take the test |
| click | 👆 Click | 👆 要你点 | Consent, a signature awaiting authorization or action-time confirmation, or a Submit*-labelled intermediate button |
| ready | ✅ Ready to submit | ✅ 待提交 | Final review and submission only |

## Finish

On the final review page, before any submit button, choose the first matching state above. Set `✅ Ready to submit {{company}}` (or `✅ 待提交 {{company}}` in Chinese) only when no other action remains; otherwise keep the earlier action title. Keep it set with `setInterval`, because single-page apps reset titles.

Report back concisely:

- the tab ID and the page where you stopped;
- every box or button the user must click;
- every field left blank or uncertain, by its exact question, with options, required or optional, and length limit;
- the exact resume file uploaded, and whether a transcript was uploaded and why;
- any value you were unsure of (there should be none you guessed).
````

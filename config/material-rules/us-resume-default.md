# Opinionated U.S. Resume Defaults

[English](us-resume-default.md) | [简体中文](us-resume-default.zh-CN.md)

These rules capture the project author's tested resume workflow and are included so other users receive a useful default instead of an empty policy. They apply to U.S. English resumes only. They do not apply to cover-letter prose. A user's explicit instruction or configured personal rule file can override them, and every override must be recorded in the artifact audit.

## Structure and selection

- Use exactly three sections in this order: Education, Experience, Skills
- Omit Professional Summary, Projects or Selected Projects, and a standalone Certifications section; place relevant certifications under Skills
- Order experience in reverse chronological order
- Select relevant experience and accomplishments instead of listing every task
- Keep research, work, and teaching within the unified Experience section when they are relevant

## Typography and layout

- Use a black-and-white, single-page U.S. Letter layout unless the user requests another format
- Use 11 point body, contact, and section text with a clearly larger bold name; the included reference implementation uses a 20 point name
- Keep margins at or above 0.5 inch on every side
- Do not use a headshot, icons, tables, or a street address
- Keep visible contact links printable; show the full LinkedIn profile address instead of only the word `LinkedIn`
- Balance white space and avoid a detached final section or large unused bottom area

## Experience bullets

- Use exactly three bullets per employer by default
- Keep each bullet to no more than two rendered lines
- Use past-tense action verbs for completed work
- Use the achievement pattern: action + object or audience + method + supported result, outcome, or value
- A delivered capability is a valid result when measured business impact is unavailable
- Do not invent a metric, problem, deployment state, user group, or outcome to complete the pattern
- Do not end bullets with punctuation
- Review an employer's bullets together and merge duplicate descriptions of the same accomplishment

## Content and language

- Write natural, direct American English and avoid translated noun strings or keyword stuffing
- Do not use first-person pronouns
- Avoid unnecessary abbreviations; preserve official company, product, framework, and algorithm names
- Use Title Case consistently for ordinary competencies in Skills while preserving official spellings
- Do not include test scores unless the user explicitly requests them
- Treat word count as informational; do not add filler to reach a target
- Treat the number of action verbs as informational; clarity matters more than an arbitrary count
- Preserve the distinction between prototype, internal use, test, deployed, and production evidence

## Required final-artifact audit

Check the actual final PDF after every content or layout change. Record the file path, SHA-256, generation time, section order, chronology, bullet counts, rendered bullet line counts, actual font sizes, margins, links, page count, white space, and all exclusions above. Use `pass`, `fail`, or `needs_review` for every rule. A successful build, one-page result, template selection, or older audit does not prove the current PDF complies.

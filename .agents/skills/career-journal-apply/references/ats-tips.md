# ATS filling tips

[English](ats-tips.md) | [简体中文](ats-tips.zh-CN.md)

Generic technique for filling applications on common applicant tracking systems (ATS) in the user's own browser. Nothing here is specific to one person. Sites change; when a tip no longer matches what the page shows, trust the page, stay within the hard rules, and report the difference.

The hard rules in [`../SKILL.md`](../SKILL.md) apply on every site: no Submit*-labelled clicks, no sign-in, account, password, or code, no CAPTCHA, no consent or signature, no essays, transcript only when required, one resume, and work descriptions one bullet per line prefixed "• ".

## Every site

### Tabs and pages

- Each sub-agent opens and uses its own tab. Never act in a tab another sub-agent or the user is using.
- The user may close a tab group, or the browser extension may disconnect. Re-open the apply link in a new tab and resume from the site's saved draft; fill again from the start where the site keeps no draft.
- Never reload a half-filled page. A reload can drop unsaved answers or start a second application.
- Some pages render nothing until the tab is actually shown. If the page text or accessibility tree is empty, take a screenshot first, then read the page again.
- Keep the tab title set with a timer, because single-page apps reset it:

  ```js
  const title = '✅ Ready to submit ExampleCorp';
  clearInterval(window.__cjTitleTimer);
  document.title = title;
  window.__cjTitleTimer = setInterval(() => { if (document.title !== title) document.title = title; }, 1000);
  ```

### Setting values

- Tabs are usually hidden, so synthetic keyboard and mouse events may not land. Prefer JavaScript, then read every value back before moving on.
- Text inputs and text areas: call the native value setter, then dispatch `input` and `change`, then blur:

  ```js
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  ```

- React selects: resolve the **current** fiber before selecting. Find the element's `__reactFiber$` key, walk `return` up to the HostRoot, and if `root.stateNode.current !== root`, use `fiber.alternate`. Then walk up from that fiber to the select component instance and call its own `selectOption` with an option from its `props.options`:

  ```js
  function currentFiber(el) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber = el[key];
    let root = fiber;
    while (root.return) root = root.return;
    if (root.stateNode && root.stateNode.current !== root && fiber.alternate) fiber = fiber.alternate;
    return fiber;
  }
  function chooseReactSelect(el, label) {
    for (let f = currentFiber(el); f; f = f.return) {
      const select = f.stateNode;
      if (select && typeof select.selectOption === 'function') {
        const option = (select.props.options ?? []).find((o) => o.label === label);
        if (!option) throw new Error(`No option ${label}`);
        select.selectOption(option);
        return;
      }
    }
    throw new Error('No React select instance found');
  }
  ```

- select2 widgets: use the page's jQuery, for example `$(el).val(value).trigger('change')`.
- Native `<select>`: set `value` to an existing option's value and dispatch `change`.
- Typeahead or combobox fields: type, wait for the list, then pick the matching `[role=option]`. Never leave free text where the site expects a picked option.
- Sleep with a MessageChannel. `setTimeout` is throttled in hidden tabs:

  ```js
  const sleep = (ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => (Date.now() >= end ? resolve() : channel.port2.postMessage(null));
    channel.port2.postMessage(null);
  });
  ```

### Files and parsed resumes

- Upload with the host's file-upload tool and a reference to the `<input type=file>`; then confirm the page shows the file name.
- Many sites parse the resume to prefill education and work history. Check every parsed field against the answers sheet, delete wrong or duplicate entries, and re-enter work descriptions one bullet per line prefixed "• ".
- Date fields that need a day: use the 1st of the month unless the answers sheet gives a day.

### Buttons

- Next, Continue, Save, and Save and Continue are fine.
- Any button labelled Submit*, and any other button that sends the application (some sites label it Apply, Send, or Finish on the last step), is the user's. On some sites an early-step button such as Submit Profile is already the final submission, so treat every Submit*-labelled button as final.

## Workday

- Dropdowns: click the `button[aria-haspopup]`, wait for the list, then pick the matching `[role=option]`. Multi-select prompts (for example "How did you hear about us?") open a searchable list: type, wait, and pick the option.
- Sign-in or account creation is the user's (`🔑`). "Use My Last Application" needs the user to be signed in; otherwise use the manual or resume-autofill path.
- "Autofill with Resume" creates education and work entries from the parse. Fix each entry against the answers sheet.
- Date fields are split into month and year (sometimes day) parts; set each part and read it back.
- On Voluntary Disclosures, the required terms or consent checkbox is the user's (`👆`). On Self Identify, the name and date signature is the user's (`👆`).
- The footer Back button may open a "Discard Application?" dialog. Prefer the step navigation to move between steps, and never confirm a discard.
- Save and Continue keeps a draft, so a closed tab can resume from the last saved step.

## Oracle HCM (Candidate Experience)

- The flow starts with the email address and sends a verification code to it. The user enters the code (`🔑`).
- The session is valid only in the tab where the code was verified. Keep working in that tab; opening the flow in another tab starts a new, unverified session.
- Dropdowns and comboboxes: click, type to filter, and pick the listed option; read the value back.
- An e-signature step (typed full name) near the end is the user's (`👆`).
- Completed steps are saved, so a lost tab resumes after the user verifies again.

## iCIMS

- The application form lives inside an iframe. Script the iframe's document when it is same-origin; otherwise open the iframe's `src` directly in your own tab.
- Country, State, and similar fields are custom dropdowns. Use the page's own dropdown API (or its underlying `<select>` plus `change`) instead of typing into the visible box.
- A button such as Submit Profile on an early step can be the final submission. Stop before it and set `👆` or `✅`.
- Sign-in or account creation is the user's (`🔑`). Saved profile steps survive a lost tab.

## Greenhouse

- React renders the form only once the page is shown. Take a screenshot first, then read the page.
- Questions on current boards use React selects; resolve the current fiber before selecting. Older boards use select2 or native selects.
- Security codes are emailed to the user at submit time; entering them is the user's (`🔑`).
- Embedded boards on a company site load the form in an iframe. Open the iframe `src` directly in your own tab when the embedded form cannot be scripted.
- There is no saved draft: a lost tab is filled again from the start.

## Ashby

- One-page React form. Use the native value setter for text and pick listed options for location and other comboboxes.
- Yes/No questions are often button pairs; click the right one and confirm its pressed state.
- The resume upload may autofill some fields; check each against the answers sheet.
- No saved draft: a lost tab is filled again from the start. A bot check at submit is the user's (`🤖`).

## Lever

- Plain HTML form; normal value setting usually works. Still read every value back.
- The resume upload may prefill name, email, phone, and current company; check each.
- "Additional information" is a cover-letter field. Leave it for the user and report it.
- The location field may be a typeahead; pick a listed option.
- No saved draft: a lost tab is filled again from the start. An hCaptcha at submit is the user's (`🤖`).

## Yello

- The file upload widget is a bootstrap widget that initialises lazily on click. After setting files through the file input, initialise the widget through its jQuery plugin and trigger `change` on the input, or the upload is not shown and may fail. Confirm the file name appears.
- Event registration and application forms can mix free text and dropdowns; read every value back.
- No saved draft: a lost tab is filled again from the start.

## SAP SuccessFactors

- Applying needs a candidate account; sign-in or account creation is the user's (`🔑`).
- Picklists are combobox controls: open the list and pick the item rather than typing free text.
- Date pickers follow the site's locale format; check the format shown in the field before entering a date.
- Resume parsing can add duplicate education or work rows; remove duplicates and fix the rest.
- Sessions time out after inactivity. Save often where the site offers Save, and resume from the saved application.
- The last-step button may be labelled Apply rather than Submit. It still sends the application, so it is the user's.

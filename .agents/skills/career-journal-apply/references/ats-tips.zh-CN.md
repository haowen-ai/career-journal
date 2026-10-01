# 招聘系统填表要点

[English](ats-tips.md) | [简体中文](ats-tips.zh-CN.md)

在用户自己的浏览器里填写常见招聘系统（ATS）申请表的通用方法，不针对任何个人。网站会改版；当某条要点和页面实际情况不一致时，以页面为准，遵守硬规矩，并在报告里说明差异。

[`../SKILL.zh-CN.md`](../SKILL.zh-CN.md) 中的硬规矩在每个网站都适用：不点写着 Submit* 的按钮；不登录、不注册、不输入密码或验证码；不做 CAPTCHA；不勾同意、不签名；不写作文；成绩单只在必填时上传；只用一份简历；工作描述每条一行、行首加“• ”。

## 所有网站通用

### 标签页和页面

- 每个子 Agent 自己新开并只使用自己的标签页，不在其他子 Agent 或用户正在用的标签页里操作。
- 用户可能关掉标签组，浏览器扩展也可能掉线。在新标签页中重新打开申请链接，从网站保存的草稿继续；网站不保存草稿时从头重填。
- 不得刷新填了一半的页面。刷新可能丢掉未保存的答案，或者开启第二份申请。
- 有些页面只有标签页真正显示出来后才会渲染。如果页面文字或无障碍树为空，先截一张图，再重新读取页面。
- 用定时器保持标签标题，因为单页应用会重置标题：

  ```js
  const title = '✅待提交 ExampleCorp';
  clearInterval(window.__cjTitleTimer);
  document.title = title;
  window.__cjTitleTimer = setInterval(() => { if (document.title !== title) document.title = title; }, 1000);
  ```

### 填值

- 标签页通常处于隐藏状态，模拟的键盘和鼠标事件可能不生效。优先使用 JavaScript，每个值填完都读回确认，再进行下一步。
- 文本框和多行文本框：调用原生 value setter，再触发 `input` 和 `change`，最后触发失焦：

  ```js
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  ```

- React 下拉框：选择前先找到**当前** fiber。找到元素上以 `__reactFiber$` 开头的键，沿 `return` 向上走到 HostRoot；如果 `root.stateNode.current !== root`，改用 `fiber.alternate`。再从这个 fiber 向上找到下拉组件实例，从它的 `props.options` 里取选项，调用它自己的 `selectOption`：

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

- select2 组件：使用页面自带的 jQuery，例如 `$(el).val(value).trigger('change')`。
- 原生 `<select>`：把 `value` 设为已有选项的值，再触发 `change`。
- 联想输入或 combobox 字段：输入文字，等列表出现，再选匹配的 `[role=option]`。网站要求选择选项的地方，不要只留下手打的文字。
- 用 MessageChannel 等待。隐藏标签页里的 `setTimeout` 会被降频：

  ```js
  const sleep = (ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => (Date.now() >= end ? resolve() : channel.port2.postMessage(null));
    channel.port2.postMessage(null);
  });
  ```

### 文件和简历解析

- 用宿主的文件上传工具和 `<input type=file>` 的引用上传，然后确认页面显示了文件名。
- 很多网站会解析简历并预填学历和工作经历。逐项与答案表核对，删除错误或重复的条目，并按每条一行、行首加“• ”重新填写工作描述。
- 需要具体日期的字段：答案表没有给出日期时，用当月 1 日。

### 按钮

- Next、Continue、Save、Save and Continue 可以点。
- 任何写着 Submit* 的按钮，以及其他会把申请发出去的按钮（有些网站最后一步写的是 Apply、Send 或 Finish），都由用户点。有些网站在前面步骤出现的 Submit Profile 之类按钮其实就是最终提交，所以写着 Submit* 的按钮一律当作最终提交。

## Workday

- 下拉框：点击 `button[aria-haspopup]`，等列表出现，再选匹配的 `[role=option]`。多选提示框（例如“How did you hear about us?”）会打开可搜索列表：输入、等待、再选。
- 登录或注册账号由用户完成（`🔑`）。“Use My Last Application”需要用户先登录；否则走手动填写或简历自动填写。
- “Autofill with Resume”会根据解析结果生成学历和工作条目，逐条按答案表改正。
- 日期字段拆成月和年（有时还有日）几部分，逐个填写并读回。
- Voluntary Disclosures 页上的必勾条款或同意框由用户勾（`👆`）。Self Identify 页上的姓名和日期签名由用户填（`👆`）。
- 页脚的 Back 可能弹出“Discard Application?”对话框。在步骤之间移动时优先使用步骤导航，绝不确认放弃。
- Save and Continue 会保存草稿，标签页被关后可以从最后保存的步骤继续。

## Oracle HCM（Candidate Experience）

- 流程从邮箱地址开始，网站会向该邮箱发送验证码，由用户输入（`🔑`）。
- 会话只在完成验证的那个标签页里有效。始终在这个标签页操作；在别的标签页打开流程会开启一个新的、未验证的会话。
- 下拉框和 combobox：点击、输入筛选、选列表中的选项，并读回确认。
- 接近结束时的电子签名步骤（输入全名）由用户完成（`👆`）。
- 已完成的步骤会保存，标签页丢失后，用户重新验证即可继续。

## iCIMS

- 申请表在 iframe 里。iframe 同源时直接操作它的 document；否则在自己的标签页中直接打开 iframe 的 `src`。
- Country、State 等字段是自定义下拉框。使用页面自带的下拉框接口（或其底层的 `<select>` 加 `change` 事件），不要往可见的输入框里打字。
- 前面步骤里的 Submit Profile 之类按钮可能就是最终提交。停在它前面，并设置 `👆` 或 `✅`。
- 登录或注册账号由用户完成（`🔑`）。已保存的资料步骤在标签页丢失后仍然保留。

## Greenhouse

- React 只有在页面显示后才会渲染表单。先截图，再读取页面。
- 新版招聘页上的问题使用 React 下拉框，选择前先找到当前 fiber；旧版页面使用 select2 或原生下拉框。
- 提交时网站会把安全码发到用户邮箱，输入安全码由用户完成（`🔑`）。
- 嵌在公司官网里的招聘页会把表单放在 iframe 中。嵌入的表单无法操作时，在自己的标签页中直接打开 iframe 的 `src`。
- 不保存草稿：标签页丢失后从头重填。

## Ashby

- 单页 React 表单。文本用原生 value setter，地点等 combobox 字段从列表中选择。
- 是/否问题通常是一对按钮；点对的那个并确认它处于选中状态。
- 上传简历后可能自动填写部分字段，逐项按答案表核对。
- 不保存草稿：标签页丢失后从头重填。提交时的机器人检查由用户完成（`🤖`）。

## Lever

- 普通 HTML 表单，通常直接设置值即可，但仍要逐个读回。
- 上传简历后可能预填姓名、邮箱、电话和当前公司，逐项核对。
- “Additional information”是 cover letter 栏位，留给用户并在报告中说明。
- 地点字段可能是联想输入，要选列表中的选项。
- 不保存草稿：标签页丢失后从头重填。提交时的 hCaptcha 由用户完成（`🤖`）。

## Yello

- 文件上传组件是 bootstrap 组件，点击时才延迟初始化。通过文件输入框设置文件后，要用它的 jQuery 插件初始化组件，并在输入框上触发 `change`，否则上传不会显示，甚至可能失败。确认文件名已经显示。
- 活动报名表和申请表可能混合使用文本框和下拉框，每个值都要读回确认。
- 不保存草稿：标签页丢失后从头重填。

## SAP SuccessFactors

- 申请需要候选人账号，登录或注册由用户完成（`🔑`）。
- 选项列表是 combobox 控件：打开列表选择条目，不要手打文字。
- 日期选择器使用网站的地区格式；输入日期前先看清字段显示的格式。
- 简历解析可能生成重复的学历或工作行；删除重复项并改正其余内容。
- 一段时间不操作会话就会超时。网站提供保存时要经常保存，并从已保存的申请继续。
- 最后一步的按钮可能写着 Apply 而不是 Submit，但它同样会把申请发出去，所以由用户点。

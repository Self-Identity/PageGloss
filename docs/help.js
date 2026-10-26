/*
 * PageGloss - help page logic (bilingual + live hotkey display).
 *
 * MV3 extension pages use `script-src 'self'`, so all logic lives here instead
 * of an inline <script>. The page reads the user's configured mark hotkey and
 * shows it, rather than hard-coding a shortcut.
 */
(function () {
  'use strict';

  var S = window.PageGlossShared || {};
  var Store = window.PageGlossStore;
  var LANG_KEY = 'pg:help-lang';
  var DEFAULT_HOTKEY = (S.DEFAULT_SETTINGS && S.DEFAULT_SETTINGS.markHotkey) || 'Alt+W';

  var COPY = {
    zh: {
      title: 'PageGloss 使用说明',
      lead: '划词标记 + 自配 LLM 解释。所有数据只保存在本机浏览器里。',
      stepsTitle: '四步上手',
      steps: [
        '配置 LLM：打开设置页，填写接口地址（可直接粘贴服务商官方 base URL）、API Key 与模型名，点「测试连接」。',
        '选中文字后任选一种入口：右键「标记并解释」、按快捷键 {hotkey}（可在设置页自定义）、或点击光标旁出现的悬浮按钮 —— 悬浮窗正是为快速执行「标记并解释」准备的，一次点击即可完成。',
        '标记后注释窗自动打开：悬停可看解释、继续追问，右侧笔记窗可随手记录；点「固定」可让窗口常驻。',
        '打开设置页 → 数据 → 查看，进入「标注数据总览」：按站点分组浏览所有标注，支持多选批量删除、导出/导入 JSON、全屏阅读。'
      ],
      stepsNote: '提示：悬浮按钮与快捷键都只作用于当前选中的文本；标记成功后窗口会暂时停留，点其他位置或关闭按钮才会消失。',
      unmarkTitle: '取消标记',
      unmarkList: [
        '在某个标记上点右键，选「取消此处标记」：只去掉这一处。',
        '在标记上点右键，选「取消该词的全部标记」：去掉这个文本的所有位置。',
        '点扩展图标，在「本页标注」里逐条删除，或点「清空本页全部标注」。'
      ],
      contextTitle: '三种上下文发送方式',
      contextLead: '在扩展图标的弹窗里切换；切换后会刷新当前标签页以套用新策略。',
      ctxMode: '方式',
      ctxContent: '发送给模型的内容',
      contextRows: [
        ['整页正文（默认）', '页面全部正文 + 该段文本所在的完整句子。理解最充分，token 消耗最高；页面超长会自动截断。'],
        ['所在章节 + 关键片段', '该文本所在段落/章节 + 完整句子 + 全页去重后的关键片段。成本明显更低。'],
        ['仅所在句子', '该段文本所在的完整句子与相邻各一段。最省 token。']
      ],
      hotkeyTitle: '快捷键',
      hotkeyLine: '标记并解释：{hotkey}（默认 Alt+W，可在设置页自定义）',
      escLine: 'Esc：关闭当前注释窗、取消选区与悬浮按钮。',
      hotkeyNote: '没有全局开关快捷键：安装本扩展后默认生效，需要暂停时可在弹窗里关闭开关。',
      privacyTitle: '数据与隐私',
      privacyList: [
        '标注位置、颜色、笔记与聊天记录按网址保存在 chrome.storage.local。',
        '系统提示词只在每次提问时临时使用，不会写入页面的标注缓存。',
        'API Key 仅保存在本机，只会发送给你填写的接口地址。',
        '在设置页可导出全部数据为 JSON，或一键清空。'
      ],
      footer: '标注数据总览位于「设置页 → 数据 → 查看」，支持多选删除与导出导入。'
    },
    en: {
      title: 'PageGloss Help',
      lead: 'Mark text and explain it with your own LLM. All data stays in your browser.',
      stepsTitle: 'Four steps',
      steps: [
        'Configure the LLM: open the options page, paste the provider base URL, your API key and the model id, then press "Test connection".',
        'Select text and use any entry point: right-click "Mark and explain", press {hotkey} (customisable in the options page), or click the floating button next to the cursor — it exists to run "Mark and explain" in one click.',
        'The annotation card opens by itself: hover to read the explanation, ask follow-ups, and use the note pane on the right. "Pin" keeps the window in place.',
        'Open options → Data → View for the annotation overview: browse by site, multi-select and delete in bulk, export/import JSON, and open the full-page reader.'
      ],
      stepsNote: 'Tip: the floating button and the hotkey only act on the current selection. After marking, the window stays until you click elsewhere or close it.',
      unmarkTitle: 'Removing marks',
      unmarkList: [
        'Right-click a mark and choose "Remove this occurrence" to remove just that one.',
        'Right-click a mark and choose "Remove every mark for this text" to remove all occurrences.',
        'Open the extension popup and delete rows under "Annotations on this page", or press "Clear every mark on this page".'
      ],
      contextTitle: 'Three context modes',
      contextLead: 'Switch them in the extension popup; the current tab reloads to apply the new strategy.',
      ctxMode: 'Mode',
      ctxContent: 'Sent to the model',
      contextRows: [
        ['Whole page (default)', 'The full page text plus the complete sentence around the term. Best understanding, highest token cost; long pages are truncated.'],
        ['Section + excerpts', 'The enclosing section, the full sentence and deduplicated excerpts from the page. Clearly cheaper.'],
        ['Sentence only', 'The full sentence around the term plus one neighbouring paragraph. Cheapest.']
      ],
      hotkeyTitle: 'Shortcuts',
      hotkeyLine: 'Mark and explain: {hotkey} (default Alt+W, customisable in the options page)',
      escLine: 'Esc: close the annotation card, clear the selection and hide the floating button.',
      hotkeyNote: 'There is no global toggle shortcut: the extension is active once installed. Use the popup switch to pause it.',
      privacyTitle: 'Data and privacy',
      privacyList: [
        'Mark positions, colours, notes and chats are stored per URL in chrome.storage.local.',
        'The system prompt is used only for the current request and is never written into the page cache.',
        'The API key stays on this machine and is only sent to the endpoint you configured.',
        'The options page can export everything as JSON or clear it.'
      ],
      footer: 'The annotation overview lives in options → Data → View, with multi-select delete and JSON export/import.'
    }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function appendWithHotkey(node, template) {
    var parts = String(template == null ? '' : template).split('{hotkey}');
    parts.forEach(function (part, index) {
      if (index > 0) appendHotkey(node);
      if (part) node.appendChild(document.createTextNode(part));
    });
  }

  function appendHotkey(node) {
    var parts = String(hotkey || DEFAULT_HOTKEY).split('+').filter(Boolean);
    if (!parts.length) parts = [DEFAULT_HOTKEY];
    parts.forEach(function (part, index) {
      if (index > 0) node.appendChild(document.createTextNode(' + '));
      var kbd = document.createElement('kbd');
      kbd.textContent = part;
      node.appendChild(kbd);
    });
  }

  function readStoredLang() {
    try {
      var value = window.localStorage.getItem(LANG_KEY);
      return value === 'en' ? 'en' : 'zh';
    } catch (err) {
      return 'zh';
    }
  }

  function storeLang(lang) {
    try { window.localStorage.setItem(LANG_KEY, lang); } catch (err) { /* ignore */ }
  }

  var hotkey = DEFAULT_HOTKEY;

  function render(lang) {
    var copy = COPY[lang] || COPY.zh;
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.title = copy.title;
    $('title').textContent = copy.title;
    $('lead').textContent = copy.lead;

    $('stepsTitle').textContent = copy.stepsTitle;
    var steps = $('steps');
    steps.textContent = '';
    copy.steps.forEach(function (text) {
      var li = document.createElement('li');
      appendWithHotkey(li, text);
      steps.appendChild(li);
    });
    $('stepsNote').textContent = copy.stepsNote;

    $('unmarkTitle').textContent = copy.unmarkTitle;
    fillList('unmarkList', copy.unmarkList);

    $('contextTitle').textContent = copy.contextTitle;
    $('contextLead').textContent = copy.contextLead;
    $('ctxMode').textContent = copy.ctxMode;
    $('ctxContent').textContent = copy.ctxContent;
    var rows = $('contextRows');
    rows.textContent = '';
    copy.contextRows.forEach(function (pair) {
      var tr = document.createElement('tr');
      var th = document.createElement('td');
      th.className = 'nowrap';
      th.textContent = pair[0];
      var td = document.createElement('td');
      td.textContent = pair[1];
      tr.appendChild(th);
      tr.appendChild(td);
      rows.appendChild(tr);
    });

    $('hotkeyTitle').textContent = copy.hotkeyTitle;
    $('hotkeyLine').textContent = '';
    appendWithHotkey($('hotkeyLine'), copy.hotkeyLine);
    $('escLine').textContent = copy.escLine;
    $('hotkeyNote').textContent = copy.hotkeyNote;

    $('privacyTitle').textContent = copy.privacyTitle;
    fillList('privacyList', copy.privacyList);
    $('footer').textContent = copy.footer;

    $('langZh').setAttribute('aria-pressed', lang === 'zh' ? 'true' : 'false');
    $('langEn').setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
  }

  function fillList(id, items) {
    var list = $(id);
    list.textContent = '';
    (items || []).forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
  }

  function setLang(lang) {
    storeLang(lang);
    render(lang);
  }

  function bind() {
    $('langZh').addEventListener('click', function () { setLang('zh'); });
    $('langEn').addEventListener('click', function () { setLang('en'); });
  }

  async function boot() {
    var lang = readStoredLang();
    render(lang);
    bind();
    if (Store && typeof Store.getSettings === 'function') {
      try {
        var settings = await Store.getSettings();
        if (settings && settings.markHotkey) {
          hotkey = settings.markHotkey;
          render(lang);
        }
      } catch (err) { /* keep the default */ }
    }
  }

  boot();
})();

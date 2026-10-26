/* PageGloss dev seed page logic (external file: MV3 CSP blocks inline scripts). */
(function () {
      'use strict';

      var Store = window.PageGlossStore;
      var S = window.PageGlossShared;

      var out = document.getElementById('output');
      var current = document.getElementById('current');
      var seedBtn = document.getElementById('seed');
      var clearBtn = document.getElementById('clear');

      var COLORS = ['#fff2a8', '#b7ecc0', '#b9e2ff', '#ffd6cc', '#e2d3ff', '#ffe0b3', '#c8f2ef', '#f6d4ec'];

      var LONG_TAIL = ' 这一段刻意写得比较长，用来检查标注格子的 overflow-wrap:anywhere 与 2-3 行截断是否生效，'

        + '同时确认悬停浮层里的长解释能够滚动查看，不会撑破视口。';

      var SAMPLES = [
        {
          text: 'idempotent',
          sentence: 'HTTP PUT is idempotent: repeating the same request leaves the server in the same state.',
          explanation: '幂等（idempotent）：同一个请求重复执行多次，服务端状态与执行一次相同。\n\n'
            + '- 本义：数学里 f(f(x)) = f(x)。\n'
            + '- HTTP：PUT、DELETE 通常幂等，POST 不保证。\n'
            + '- 本页所指：重试上传接口不会产生重复记录。'
        },
        {
          text: 'zero-build extension',
          sentence: 'A zero-build extension ships native JS straight from the source folder.',
          explanation: '零构建扩展：没有打包器与编译步骤，源码目录就是扩展运行时加载的文件。\n\n'
            + '优点是改完刷新即生效；代价是没有类型检查、tree-shaking 和自动压缩。'
        },
        {
          text: 'chrome.storage.local',
          sentence: 'chrome.storage.local stores the page index separately from each page record.',
          explanation: '扩展的本地持久化存储。与 localStorage 不同，它能在内容脚本、后台与设置页之间共享，'
            + '并且支持 unlimitedStorage 权限。本页把它用来保存 `pg:index` 与 `pg:page:<urlKey>`。'
        },
        {
          text: 'MV3 service worker',
          sentence: 'The MV3 service worker sleeps between events, so all state must be persisted.',
          explanation: 'Manifest V3 的后台是一个可被随时休眠的 service worker。\n\n'
            + '因此不能依赖内存里的全局变量，标注与设置都要落到 chrome.storage.local。'
        },
        {
          text: '文本截断',
          sentence: '标题和 URL 都用 text-overflow: ellipsis 截断，完整内容放在 title 属性里。',
          explanation: '用 CSS 省略号控制单行溢出，同时把完整文本放进 title，鼠标悬停即可看到全部内容，'
            + '避免长 URL 把布局撑坏。'
        },
        {
          text: '分页状态',
          sentence: '每个标题的矩阵分页独立保存，切换别的标题不会把当前页重置。',
          explanation: '数据页用 pageIndex[site] 记录标题列表的页码，用 matrixIndex[pageKey] 记录矩阵页码，'
            + '两者互不影响。'
        },
        {
          text: '存储配额',
          sentence: '如果用户禁用了站点数据，storage.local 会抛错，数据页需要给出可读的失败提示。',
          explanation: 'chrome.storage 可能因为企业策略、无痕模式限制或用户清除数据而写入失败。'
            + '数据页在读取失败时显示 dataLoadFail，而不是静默空白。'
        },
        {
          text: '悬停浮层',
          sentence: '浮层锚定在格子下方，空间不足时自动翻转到上方，并限制在视口内。',
          explanation: '浮层用 position: fixed 定位在格子附近，位置计算会做左右与上下夹取；'
            + '鼠标移出格子和浮层后延时销毁节点，不在 DOM 里留下隐藏的残留。'
        },
        {
          text: 'CJK 断词',
          sentence: '中文长句没有空格，必须用 overflow-wrap: anywhere 才能安全换行。',
          explanation: '中文与长 URL 一样没有天然断点，overflow-wrap: anywhere 允许在任意字符处换行，'
            + '配合 min-width: 0 才能让网格子项不撑破容器。'
        },
        {
          text: 'keyboard focus',
          sentence: 'Every row is a real button, so Tab, Enter and Space work without extra handlers.',
          explanation: '数据页的可点击行都用 <button>，键盘可聚焦，按 Enter/Space 触发与鼠标点击一致的行为，'
            + '并用 :focus-visible 显示焦点环。'
        },
        {
          text: 'prefers-reduced-motion',
          sentence: 'Users who ask for reduced motion should not see the chevron or spinner animation.',
          explanation: '系统开启「减少动态效果」时，通过 @media (prefers-reduced-motion: reduce) 把 transition/'
            + 'animation 时长压到接近零。'
        },
        {
          text: '深色主题',
          sentence: '配色全部走 CSS 变量，深色模式只覆盖变量，不复制组件样式。',
          explanation: '数据页与设置页共用 --pg-accent / --pg-bg / --pg-surface / --pg-fg / --pg-fg-dim / '
            + '--pg-border 等 token，prefers-color-scheme: dark 下重定义变量即可。'
        }
      ];

      var NOTE_SAMPLES = [
        '重试策略必须建立在幂等之上，否则会重复扣款。',
        '这里和设置页的 dataView 按钮对应，记得一起回归。',
        'Read this again before changing the pagination constants.',
        '检查深色模式下浮层阴影是否仍然可见；必要时调大 --pg-pop-shadow。',
        'Long note: 这条笔记故意写长，用来验证笔记窗格在有限高度内可以独立滚动，并且不会把解释窗格挤到视口之外。'
          + '再加一句，让内容超过六行，观察浮层的 max-height 与 overflow-y 是否正确生效。'
      ];

      function report(lines, isError) {
        var text = Array.isArray(lines) ? lines.join('\n') : String(lines);
        out.textContent = text;
        out.classList.toggle('is-error', !!isError);
      }

      function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
      }

      function explanationFor(index, isEnglish) {
        if (isEnglish) {
          return 'Sample explanation #' + index + ': this mark exists to test English wrapping, the hover panel '
            + 'and the note column.' + LONG_TAIL;
        }
        return '示例解释 #' + index + '：这条标注用来验证中文长文本换行、悬停浮层与笔记栏。' + LONG_TAIL;
      }

      function makeAnnotation(pageIndex, index, spec) {
        var now = Date.now();
        var createdAt = now - (((pageIndex + 1) * 7 + index) * 61 * 60 * 1000);
        var updatedAt = createdAt + 20 * 60 * 1000;
        var note = spec.note || '';
        return {
          id: S.uuid(),
          text: spec.text,
          color: COLORS[(pageIndex + index) % COLORS.length],
          sentence: spec.sentence || spec.text,
          explanation: spec.explanation == null ? explanationFor(index, spec.en) : spec.explanation,
          note: note,
          noteUpdatedAt: note ? updatedAt + 3 * 60 * 1000 : 0,
          createdAt: createdAt,
          updatedAt: updatedAt,
          marks: 1 + (index % 3),
          anchors: []
        };
      }

      function buildAnnotations(count, pageIndex) {
        var list = [];
        for (var i = 0; i < count; i++) {
          var spec = SAMPLES[(pageIndex + i) % SAMPLES.length];
          var note = '';
          if (i === 1) note = NOTE_SAMPLES[(pageIndex + i) % NOTE_SAMPLES.length];
          else if (i === 4) note = NOTE_SAMPLES[(pageIndex + i) % NOTE_SAMPLES.length];
          var text = spec.text;
          if (i % 17 === 2) text = spec.text + '：' + LONG_TAIL;
          list.push(makeAnnotation(pageIndex, i, {
            text: text,
            sentence: spec.sentence,
            explanation: spec.explanation,
            note: note,
            en: !S.hasChinese(spec.text)
          }));
        }
        return list;
      }

      function makePage(url, title, annotations, chats) {
        return {
          urlKey: S.normalizeUrlKey(url),
          url: url,
          title: title,
          updatedAt: Date.now(),
          annotations: annotations,
          chats: chats || {}
        };
      }

      function buildPages() {
        var pages = [];
        var titles = [
          '60 条标注：矩阵 5 × 10 分页与长文本截断',
          'Designing a zero-build MV3 extension',
          '第 3 篇：chrome.storage.local 的索引设计',
          'Idempotent retries and safe PUT semantics',
          '长标题测试：这一行故意写得非常长，用来检查窄屏下的省略号与完整 title 提示是否正常',
          'Boundary conditions in a 5 × 10 matrix',
          '第 7 篇：中文、English 与 mixed 内容混排',
          'Keyboard focus, Escape and reduced motion',
          '第 9 篇：深色主题下的对比度',
          'Pagination state per page, not per site',
          '第 11 篇：浮层翻转与视口限制',
          'Notes everywhere: 一段很长的笔记样本'
        ];
        var counts = [60, 3, 6, 4, 5, 3, 6, 4, 5, 3, 6, 4];

        for (var i = 0; i < titles.length; i++) {
          var number = ('0' + (i + 1)).slice(-2);
          pages.push(makePage(
            'https://demo.example.com/articles/' + number,
            titles[i],
            buildAnnotations(counts[i], i),
            {}
          ));
        }

        pages.push(makePage(
          'https://docs.example.org/guide/installation',
          'Installation: load unpacked and reload',
          buildAnnotations(4, 20),
          {}
        ));
        var architecture = buildAnnotations(5, 21);
        architecture[3].explanation = '';
        pages.push(makePage(
          'https://docs.example.org/guide/architecture',
          'Architecture: storage, background and content scripts',
          architecture,
          {}
        ));

        var reading = buildAnnotations(6, 30);
        var fallback = reading[0];
        fallback.explanation = '';
        var chats = {};
        chats[fallback.id] = [
          { role: 'user', content: 'Explain this mark', at: Date.now() - 120000 },
          {
            role: 'assistant',
            content: '这条解释只存在于对话记录里：数据页在没有 annotation.explanation 时，会回退到第一条 assistant 消息。',
            at: Date.now() - 60000
          }
        ];
        pages.push(makePage(
          'https://www.zh.example.net/notes/2026/reading',
          '阅读笔记：中文、English 与长文本混排',
          reading,
          chats
        ));

        pages.push(makePage(
          'https://zh.example.net/notes/2026/language',
          '多语言与排版观察',
          buildAnnotations(5, 31),
          {}
        ));

        return pages;
      }

      function countAnnotations(pages) {
        var total = 0;
        pages.forEach(function (page) {
          total += page.annotations.length;
        });
        return total;
      }

      function countSites(pages) {
        var seen = {};
        var total = 0;
        pages.forEach(function (page) {
          var key = S.siteGroupOf(page.url);
          if (!seen[key]) {
            seen[key] = true;
            total++;
          }
        });
        return total;
      }

      function refreshCurrent() {
        return Store.getAllPages().then(function (pages) {
          current.textContent = '当前缓存：' + pages.length + ' 个页面 · ' +
            countAnnotations(pages) + ' 条标注 · ' + countSites(pages) + ' 个站点';
        }).catch(function (err) {
          current.textContent = '读取当前缓存失败：' + ((err && err.message) || String(err));
        });
      }

      async function seed() {
        seedBtn.disabled = true;
        clearBtn.disabled = true;
        report('正在写入…', false);
        try {
          var before = await Store.get(S.STORAGE_INDEX_KEY);
          var beforeIndex = before && before[S.STORAGE_INDEX_KEY] ? before[S.STORAGE_INDEX_KEY] : {};
          var beforePages = Object.keys(beforeIndex).length;
          var pages = buildPages();
          // savePage stamps updatedAt with "now", so save in reverse: the demo
          // site and its 60-annotation page end up first in the data page.
          var saveOrder = pages.slice().reverse();
          for (var i = 0; i < saveOrder.length; i++) {
            await Store.savePage(saveOrder[i]);
            await sleep(12);
          }
          var annotations = countAnnotations(pages);
          var pagesBySite = Object.create(null);
          var maxPageSize = 0;
          pages.forEach(function (page) {
            var groupKey = S.siteGroupOf(page.url);
            pagesBySite[groupKey] = (pagesBySite[groupKey] || 0) + 1;
            if (page.annotations.length > maxPageSize) maxPageSize = page.annotations.length;
          });
          var maxSitePages = 0;
          Object.keys(pagesBySite).forEach(function (key) {
            if (pagesBySite[key] > maxSitePages) maxSitePages = pagesBySite[key];
          });
          report([
            '写入完成。',
            '站点：' + countSites(pages) + ' · 页面：' + pages.length + ' · 标注：' + annotations,
            '覆盖：1 个站点 ' + maxSitePages + ' 个页面（标题每页 10 行 · 需要翻页）、1 个页面 ' + maxPageSize + ' 条标注（矩阵 5 × 10 · 需要翻页）、',
            '      带笔记 / 无笔记 / 长文本 / 中英混排 / explanation 为空但有 assistant 对话（浮层回退）。',
            '写入前的索引：' + beforePages + ' 个页面。'
          ], false);
          await refreshCurrent();
        } catch (err) {
          report('写入失败：' + ((err && err.message) || String(err)), true);
        } finally {
          seedBtn.disabled = false;
          clearBtn.disabled = false;
        }
      }

      async function clearAll() {
        seedBtn.disabled = true;
        clearBtn.disabled = true;
        report('正在清空…', false);
        try {
          var removed = await Store.clearAll();
          report('已清空全部数据（移除 ' + removed + ' 个存储键）。', false);
          await refreshCurrent();
        } catch (err) {
          report('清空失败：' + ((err && err.message) || String(err)), true);
        } finally {
          seedBtn.disabled = false;
          clearBtn.disabled = false;
        }
      }

      seedBtn.addEventListener('click', seed);
      clearBtn.addEventListener('click', clearAll);
      refreshCurrent();
    })();

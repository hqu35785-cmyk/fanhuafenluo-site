/* ==========================================================================
   motion.js — 繁花·纷落 角色卡档案 · 动效驱动
   --------------------------------------------------------------------------
   职责：只负责给元素挂 data-motion 属性和 mo-* 类，动画本身全在 motion.css 里。
   不接管、不修改站点任何业务逻辑（数据加载、弹窗开关、PNG 导出都保持原样）。

   选择器配置已经按当前页面真实结构适配；其余逻辑只负责挂载动效类。
   ========================================================================== */
(function () {
  'use strict';

  /* ====================== ① 选择器配置 ====================== */
  const SEL = {
    authorTabs:    '.author-filter',
    heroTitle:     '#headerAuthorName',
    heroStatus:    '#status span',
    heroCta:       '.detail-action',
    heroArrow:     '.download-icon',
    cardGrid:      '#archiveGallery',
    card:          '.archive-card',
    section:       'footer',
    modalBackdrop: '#archiveModal',
    modalPanel:    '#archiveModal .archive-modal-panel',
    tabButtons:    '#archiveModal .detail-option',
    tabPanels:     '#archiveModal .detail-reading-body',
    sheet:         '#saveSheet'
  };

  /* ====================== ② 工具 ====================== */
  const $  = (s, r) => (s ? (r || document).querySelector(s) : null);
  const $$ = (s, r) => (s ? Array.from((r || document).querySelectorAll(s)) : []);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MAX_DELAY = 420;   // 单个元素最大延迟，防止长列表尾部等太久

  function mark(el, motion, opts) {
    if (!el || el.dataset.motion) return;
    opts = opts || {};
    el.dataset.motion = motion;
    if (opts.cls) el.classList.add(opts.cls);

    // 已经在屏幕上的，就地入场，一帧都不隐藏。
    if (inView(el)) { enter(el, !SKIP_ENTRANCE); return; }

    // 只有屏幕外的才藏起来等滚动，藏的时候用户本来也看不见它。
    if (opts.delay && !REDUCED) el.dataset.moDelay = opts.delay;
    el.classList.add('mo-hide');
    io.observe(el);
  }

  /* ====================== ③ 入场 ====================== */
  /* 整套机制只有一条规则：屏幕上的元素永远不隐藏。
     隐藏状态（mo-hide）只加在视口之外的元素上，所以无论 IntersectionObserver
     迟到、不来，还是动画根本没跑起来，用户看到的都不可能是一片黑。
     正因为如此，这里不需要任何轮询兜底。 */

  /* 首屏要不要补入场动画。以下两种情况一律不补，直接落到最终状态：
     1) 页面已经画出来了。文档是边解析边画的，deferred 脚本执行时首屏往往
        已经在屏幕上了；这时再补一段从 opacity:0 起步的动画，等于把用户已经
        看见的内容重新抹黑再淡入——手机上「从黑的加载出来」正是这么来的。
     2) 文档当前不可见（后台标签页、被节流的合成器）。动画不会推进，元素会
        卡在首帧的透明上；而且本来也没人在看，补了没有意义。
     动画只是锦上添花，任何拿不准的情况都按「直接显示」处理。 */
  const SKIP_ENTRANCE =
    performance.getEntriesByType('paint').length > 0 || document.hidden;

  function inView(el) {
    const box = el.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight;
  }

  function enter(el, animate) {
    if (el.dataset.moIn) return;                    // 只播一次，不重播
    el.dataset.moIn = '1';
    el.classList.remove('mo-hide');
    io.unobserve(el);
    if (animate === false) return;
    el.classList.add('is-in');
    el.addEventListener('animationend', function () {
      el.style.willChange = '';
    }, { once: true });
  }

  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      const el = e.target;
      const delay = REDUCED ? 0 : +el.dataset.moDelay || 0;
      // 交错期间元素仍然是 mo-hide，推迟挂 is-in 不会闪
      if (delay) setTimeout(function () { enter(el); }, delay);
      else enter(el);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

  /* mo-hide 的前提是「这东西在屏幕外」。IO 的回调跟着渲染步骤派发，被节流时
     可能迟到甚至不来；切换作者之类的布局变化也可能把屏幕外的元素直接挪到屏幕上，
     期间一个 scroll 事件都没有。所以凡是已经露出一半却还挂着 mo-hide 的，
     一律直接显示——判据比 IO 宽松得多，正常情况下轮不到它出手。 */
  function revealVisible() {
    $$('[data-motion].mo-hide').forEach(function (el) {
      const box = el.getBoundingClientRect();
      const shown = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
      // 走到这一步说明 IO 没能及时接手，直接显示，不再补动画
      if (shown > Math.min(box.height, innerHeight) / 2) enter(el, false);
    });
  }

  // 不用 requestAnimationFrame —— 页面被节流时它同样不触发。
  let lastReveal = 0;
  ['scroll', 'resize', 'orientationchange'].forEach(function (type) {
    addEventListener(type, function () {
      const now = Date.now();
      if (now - lastReveal < 120) return;
      lastReveal = now;
      revealVisible();
    }, { passive: true });
  });

  /* ====================== ④ 首屏 ====================== */
  function initHero() {
    // 作者切换 tab：从上往下，短促，依次 40ms
    $$(SEL.authorTabs).forEach(function (el, i) {
      mark(el, 'sweep-down', { cls: 'mo-tab', delay: i * 40 });
    });

    // 主标题：逐行从下往上；有子元素就按子元素分行
    const title = $(SEL.heroTitle);
    if (title) {
      const lines = Array.from(title.children).filter(function (n) {
        return n.nodeType === 1 && n.offsetHeight;
      });
      if (lines.length > 1) {
        lines.forEach(function (line, i) {
          mark(line, 'sweep-up', { cls: 'mo-title', delay: i * 80 });
        });
      } else {
        mark(title, 'sweep-up', { cls: 'mo-title' });
      }
    }

    // 状态小字（ARCHIVE MATERIALIZING / WAITING…）：模糊聚焦，不位移
    $$(SEL.heroStatus).forEach(function (el) {
      mark(el, 'focus-in', { cls: 'mo-status' });
    });

    // 「查看档案」：落定，带回弹
    $$(SEL.heroCta).forEach(function (el) {
      mark(el, 'settle', { cls: 'mo-cta' });
    });

    // ⇩ 箭头：与按钮解耦，但保持静态
    $$(SEL.heroArrow).forEach(function (el) { el.classList.add('mo-arrow'); });

    // 其它区块：常规上浮
    $$(SEL.section).forEach(function (el) {
      mark(el, 'rise', { cls: 'mo-section' });
    });
  }

  /* ====================== ⑤ 卡片网格：奇偶列反向 + 斜向波浪 ====================== */
  function layoutCards(grid) {
    const cards = $$(SEL.card, grid).filter(function (c) { return !c.dataset.motion; });
    if (!cards.length) return;

    const rows = new Map();
    cards.forEach(function (c) {
      const key = Math.round(c.offsetTop / 8) * 8;      // 容忍 1~2px 抖动
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(c);
    });

    Array.from(rows.keys()).sort(function (a, b) { return a - b; })
      .forEach(function (key, rowIndex) {
        rows.get(key).forEach(function (card, col) {
          card.classList.add('mo-card');
          mark($(SEL.heroCta, card), 'settle', { cls: 'mo-cta' });
          $$(SEL.heroArrow, card).forEach(function (el) { el.classList.add('mo-arrow'); });
          mark(card, col % 2 ? 'sweep-up' : 'sweep-down', {
            delay: Math.min((rowIndex * 2 + col) * 60, MAX_DELAY)
          });
        });
      });
  }

  function initCards() {
    const grid = $(SEL.cardGrid) || document.body;
    layoutCards(grid);

    // 卡片是异步插入的；显示/隐藏又是靠 hidden 属性切的。两者都会改变布局，
    // 也就都可能把原本在屏幕外、正挂着 mo-hide 的元素挪到屏幕上。
    let t;
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(function () { layoutCards(grid); revealVisible(); }, 80);
    }).observe(grid, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden']
    });
  }

  /* ====================== ⑥ 详情弹窗：以被点击的卡片为展开原点 ====================== */
  let lastRect = null;
  document.addEventListener('click', function (e) {
    const card = e.target.closest && e.target.closest(SEL.card);
    if (card) lastRect = card.getBoundingClientRect();
  }, true);

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }

  // 站点自己控制开关，这里只观察可见性变化后补上动画类
  function watchOpen(el, onOpen, onClose) {
    if (!el) return;
    let open = isVisible(el);
    if (open) onOpen(el);
    new MutationObserver(function () {
      const now = isVisible(el);
      if (now === open) return;
      open = now;
      open ? onOpen(el) : onClose(el);
    }).observe(el, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden']
    });
  }

  function replay(el, cls) {
    el.classList.remove(cls, 'is-closing');
    void el.offsetWidth;                 // 强制重排，动画可重放
    el.classList.add(cls);
  }

  function initModal() {
    const backdrop = $(SEL.modalBackdrop);
    if (!backdrop) return;
    const panel = $(SEL.modalPanel, backdrop) || $(SEL.modalPanel);

    watchOpen(backdrop, function () {
      backdrop.classList.add('mo-backdrop');
      replay(backdrop, 'mo-backdrop');

      if (!panel) return;
      panel.classList.add('mo-panel');
      if (lastRect) {
        const p = panel.getBoundingClientRect();
        const cx = lastRect.left + lastRect.width / 2 - p.left;
        const cy = lastRect.top + lastRect.height / 2 - p.top;
        panel.style.setProperty('--mo-ox', cx.toFixed(1) + 'px');
        panel.style.setProperty('--mo-oy', cy.toFixed(1) + 'px');
      }
      replay(panel, 'mo-panel');
    }, function () {
      replay(backdrop, 'is-closing');
      if (panel) replay(panel, 'is-closing');
    });
  }

  /* ====================== ⑦ 弹窗内 tab：五栏各自的语义动效 ====================== */
  function initTabs() {
    const tabs = $$(SEL.tabButtons);
    if (tabs.length < 2) return;

    const motionClasses = [
      'is-enter-intro',
      'is-enter-opening',
      'is-enter-setting',
      'is-enter-worldbook',
      'is-enter-preset'
    ];

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        const key = tab.getAttribute('data-detail-tab');
        const motionClass = 'is-enter-' + key;
        if (motionClasses.indexOf(motionClass) < 0) return;

        // 等站点自己切完 DOM 再补动画
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            const panel = $$(SEL.tabPanels).filter(isVisible)[0];
            if (!panel) return;
            panel.classList.add('mo-tabpanel');
            panel.classList.remove.apply(panel.classList, motionClasses);
            void panel.offsetWidth;
            panel.classList.add(motionClass);
          });
        });
      });
    });
  }

  /* ====================== ⑧ 保存 PNG：底部上滑 ====================== */
  function initSheet() {
    const sheet = $(SEL.sheet);
    if (!sheet) return;
    sheet.classList.add('mo-sheet');
    watchOpen(sheet,
      function () { requestAnimationFrame(function () { sheet.classList.add('is-open'); }); },
      function () { sheet.classList.remove('is-open'); }
    );
  }

  /* ====================== ⑨ 启动 ====================== */
  function boot() {
    initHero();
    initCards();
    initModal();
    initTabs();
    initSheet();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

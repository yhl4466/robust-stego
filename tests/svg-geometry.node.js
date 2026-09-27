/**
 * svg-geometry.node.js —— tech.html 内联 SVG 的几何体检工具（开发者用，需浏览器配合）
 * ============================================================================
 * 为什么需要它：SVG 里的文字溢出、重叠、越界、贴边这类问题**只有真实排版才知道**，
 * 靠人眼读代码数不出来（字号、字体、中英文混排都会影响实际宽度）。这个工具把
 * tech.html 里的每张图放进一个 1280px 宽的页面里真实渲染，再用 getBoundingClientRect
 * 量出每个元素的包围盒，逐项判定五类问题：
 *   ① 文字溢出容器：文字中心落在某个矩形内，但文字没有完全落在该矩形内
 *   ② 文字重叠：两个 <text> 的包围盒相交（留 1 单位容差）
 *   ③ 元素越界：包围盒超出 viewBox
 *   ④ 边距过紧：与 viewBox 边界距离 < 10 单位
 *   ⑤ 字号过小：字号 < 10 单位（在 1146×717 的显示尺寸下不可读）
 *
 * 用法（两步）：
 *   1) node tests/svg-geometry.node.js                 # 生成 tests/svg-geometry-probe.html
 *   2) 用 Edge/Chrome 无头模式渲染该页，把 DOM 落盘：
 *      msedge --headless --dump-dom --virtual-time-budget=20000 \
 *             "file:///<abs>/tests/svg-geometry-probe.html" > tests/svg-geometry-dump.txt
 *   3) node tests/svg-geometry.node.js --parse         # 解析落盘结果 → tests/svg-metrics.json
 * 之后 verify-page.node.js 会校验 svg-metrics.json（问题数为 0，且每张图的哈希与
 * tech.html 当前内容一致）。改了 SVG 却没重新测量，校验会失败并提示重跑本工具。
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

// 文档顺序 → 交付用的文件名（顺序错了下面会报出来）
const NAMES = [
  'figa-lsb', 'fig1-architecture', 'fig2-dct-modulation', 'fig3-redundancy', 'fig4-quadrant',
  'fig5-pilot', 'figb-phase-search', 'fig6-test-results', 'figc-hamming', 'figd-tradeoff'
];
const EXPECT_CAPTION = ['插图', '图 1：', '图 2：', '图 3：', '图 4：', '图 5：', '插图', '图 6：', '插图', '插图'];

/** 从 tech.html 抽出全部 <svg class="figure"> 块（含其后的图注） */
function extractFigures(html) {
  const out = [];
  const re = /<svg class="figure"[\s\S]*?<\/svg>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const cap = (after.match(/<p class="caption">([\s\S]*?)<\/p>/) || [, ''])[1];
    out.push({ svg: m[0], caption: cap.replace(/<[^>]+>/g, '').trim() });
  }
  return out;
}

const MEASURE_JS = `
(function () {
  'use strict';
  var NAMES = __NAMES__;
  var out = { checkWidth: 1280, tool: 'svg-geometry.node.js', figures: [], problems: [] };
  var figs = document.querySelectorAll('svg.fig');
  for (var fi = 0; fi < figs.length; fi++) {
    var svg = figs[fi];
    var name = NAMES[fi] || ('fig' + fi);
    var vb = svg.getAttribute('viewBox').split(/[\\s,]+/).map(Number);
    var vx = vb[0], vy = vb[1], vw = vb[2], vh = vb[3];
    var sr = svg.getBoundingClientRect();
    var scale = sr.width / vw;
    function toU(r) {
      return { x: (r.left - sr.left) / scale + vx, y: (r.top - sr.top) / scale + vy,
               w: r.width / scale, h: r.height / scale,
               x2: (r.right - sr.left) / scale + vx, y2: (r.bottom - sr.top) / scale + vy };
    }
    var f = { name: name, viewBox: [vx, vy, vw, vh], renderWidth: Math.round(sr.width),
              renderHeight: Math.round(sr.height), texts: [], rects: [], others: [] };
    var nodes = svg.querySelectorAll('rect, text, line, path, circle, polyline, polygon, ellipse');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r.width && !r.height) continue;
      var u = toU(r);
      var tag = el.tagName.toLowerCase();
      var rec = { tag: tag, x: +u.x.toFixed(1), y: +u.y.toFixed(1), w: +u.w.toFixed(1), h: +u.h.toFixed(1),
                  x2: +u.x2.toFixed(1), y2: +u.y2.toFixed(1),
                  text: tag === 'text' ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : undefined,
                  fontSize: tag === 'text' ? +parseFloat(cs.fontSize).toFixed(2) : undefined };
      if (tag === 'text') f.texts.push(rec); else if (tag === 'rect') f.rects.push(rec); else f.others.push(rec);
      if (u.x < vx - 0.5 || u.y < vy - 0.5 || u.x2 > vx + vw + 0.5 || u.y2 > vy + vh + 0.5) {
        out.problems.push({ fig: name, kind: '越界', detail: tag + ' ' + (rec.text || '') +
          ' 超出 viewBox（元素 ' + rec.x + ',' + rec.y + ' → ' + rec.x2 + ',' + rec.y2 + '）' });
      }
      var margin = Math.min(u.x - vx, u.y - vy, (vx + vw) - u.x2, (vy + vh) - u.y2);
      if (margin < 10 && margin > -0.5) {
        out.problems.push({ fig: name, kind: '边距过紧', detail: tag + ' ' + (rec.text || '') +
          ' 距 viewBox 边界仅 ' + margin.toFixed(1) + 'px' });
      }
      if (tag === 'text' && rec.fontSize < 10) {
        out.problems.push({ fig: name, kind: '字号过小', detail: '"' + rec.text + '" 字号 ' + rec.fontSize });
      }
    }
    for (var ti = 0; ti < f.texts.length; ti++) {
      var t = f.texts[ti];
      var cx = (t.x + t.x2) / 2, cy = (t.y + t.y2) / 2;
      for (var ri = 0; ri < f.rects.length; ri++) {
        var rr = f.rects[ri];
        if (rr.w < 40 || rr.h < 20) continue;
        if (cx >= rr.x && cx <= rr.x2 && cy >= rr.y && cy <= rr.y2) {
          var sl = t.x - rr.x, sr2 = rr.x2 - t.x2, st = t.y - rr.y, sb = rr.y2 - t.y2;
          if (sl < -1 || sr2 < -1 || st < -1 || sb < -1) {
            out.problems.push({ fig: name, kind: '文字溢出容器', detail: '"' + t.text + '" 容器=[' +
              rr.x + ',' + rr.y + ' ' + rr.w + '×' + rr.h + '] 文字=[' + t.x + ',' + t.y + ' ' + t.w + '×' + t.h +
              '] 左/右/上/下余量=' + sl.toFixed(1) + '/' + sr2.toFixed(1) + '/' + st.toFixed(1) + '/' + sb.toFixed(1) });
          }
          break;
        }
      }
    }
    for (var a = 0; a < f.texts.length; a++) {
      for (var b = a + 1; b < f.texts.length; b++) {
        var A = f.texts[a], B = f.texts[b];
        var ox = Math.min(A.x2, B.x2) - Math.max(A.x, B.x);
        var oy = Math.min(A.y2, B.y2) - Math.max(A.y, B.y);
        if (ox > 1 && oy > 1) {
          out.problems.push({ fig: name, kind: '文字重叠', detail: '"' + A.text + '" 与 "' + B.text +
            '" 相交 ' + ox.toFixed(1) + '×' + oy.toFixed(1) + 'px' });
        }
      }
    }
    out.figures.push(f);
  }
  var pre = document.createElement('pre');
  pre.id = 'svgMetrics';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
  document.title = 'metrics-done';
})();
`;

// ---------------------------------------------------------------- 生成探针页
if (process.argv.indexOf('--parse') === -1) {
  const html = fs.readFileSync(path.join(ROOT, 'tech.html'), 'utf8');
  const figs = extractFigures(html);
  const bad = [];
  figs.forEach((f, i) => {
    if (figs.length !== 10 || f.caption.indexOf(EXPECT_CAPTION[i]) !== 0) bad.push(i + 1);
  });
  if (figs.length !== NAMES.length || bad.length) {
    console.error(`！！图数量或顺序与预期不符：抽到 ${figs.length} 张，异常序号 [${bad.join(', ')}]`);
    process.exit(1);
  }
  let page = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>SVG 几何体检</title>
<style>
  body { margin: 0; background: #0f172a; color: #e6e9ef; font: 14px system-ui, "Microsoft YaHei", sans-serif; padding: 12px; }
  .probe { width: 1280px; margin: 0 auto 26px; background: #111c33; padding: 6px; box-sizing: border-box; }
  .probe svg.fig { width: 1280px; height: auto; display: block; }
  .lbl { color: #7dd3fc; font-size: 13px; margin: 2px 0 6px; }
</style></head><body>
`;
  figs.forEach((f, i) => {
    page += `<div class="probe"><div class="lbl">${NAMES[i]}</div>` +
      f.svg.replace('<svg class="figure"', '<svg class="fig"') + '</div>\n';
  });
  page += '<script>' + MEASURE_JS.replace('__NAMES__', JSON.stringify(NAMES)) + '</script></body></html>';
  fs.writeFileSync(path.join(__dirname, 'svg-geometry-probe.html'), page, 'utf8');
  console.log('已生成 tests/svg-geometry-probe.html（' + figs.length + ' 张图，检查宽度 1280）');
  console.log('下一步：用浏览器渲染并 dump-dom 到 tests/svg-geometry-dump.txt，再执行 --parse');
  process.exit(0);
}

// ---------------------------------------------------------------- 解析测量结果
{
  const dumpPath = path.join(__dirname, 'svg-geometry-dump.txt');
  if (!fs.existsSync(dumpPath)) {
    console.error('找不到 tests/svg-geometry-dump.txt —— 请先用浏览器 dump-dom 生成它');
    process.exit(1);
  }
  const raw = fs.readFileSync(dumpPath, 'utf8');
  const m = raw.match(/<pre id="svgMetrics">([\s\S]*?)<\/pre>/);
  if (!m) { console.error('落盘内容里没有 svgMetrics —— 页面可能没跑完（试试加大 --virtual-time-budget）'); process.exit(1); }
  const decoded = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const data = JSON.parse(decoded);

  // 给每张图绑定"当前 tech.html 里它的哈希"，用于检测
  // "SVG 改了但没重新测量"这种静默过期
  const html = fs.readFileSync(path.join(ROOT, 'tech.html'), 'utf8');
  const figs = extractFigures(html);
  data.figures.forEach((f, i) => {
    if (!figs[i]) return;
    f.svgSha256 = crypto.createHash('sha256').update(figs[i].svg, 'utf8').digest('hex').slice(0, 16);
    f.caption = figs[i].caption.slice(0, 40);
  });
  data.checkedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(__dirname, 'svg-metrics.json'), JSON.stringify(data, null, 1) + '\n', 'utf8');

  console.log(`图数 ${data.figures.length}，问题 ${data.problems.length}`);
  const byKind = {};
  data.problems.forEach((p) => { byKind[p.kind] = (byKind[p.kind] || 0) + 1; });
  Object.keys(byKind).forEach((k) => console.log(`  ${k}：${byKind[k]}`));
  data.problems.forEach((p) => console.log(`  [${p.kind}] ${p.fig}: ${p.detail}`));
  console.log('已写 tests/svg-metrics.json');
  process.exit(data.problems.length === 0 ? 0 : 1);
}

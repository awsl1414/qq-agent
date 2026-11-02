// 报告导出：证据包 → Markdown → .docx。
//
// ── 分工（关键）──
//   证据包完全在**本地确定性抽取**，不经模型：审计记录 + 日志片段 + 改动前后代码。
//   模型只负责把证据包"讲成人话"（叙事化），且**只允许引用证据包里已有的内容** ——
//   与 /api/doctor/ask 的既有原则一致（"绝对不要编造你没读过的日志内容或代码行"）。
//   这样报告不会"看着有理但没出处"。
//
// ── 为什么能产出真 .docx 而不加依赖 ──
//   .docx 本质是 ZIP + 若干 XML。[Content_Types].xml / _rels/.rels / word/document.xml。
//   本项目 src/market.js 已有手写 ZIP writer 的先例（CRC32 + node:zlib deflateRawSync +
//   central directory + EOCD），这里按同一套写法自实现一份（插件自包含，不跨模块 import）。
//   项目依赖极少（仅 js-yaml / undici / ws），不该为一个导出功能引第三方包。

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { readVerify, simpleDiff, readJsonSafe } from './core.js';

// ── 证据包 ────────────────────────────────────────────────────────────────

/**
 * 抽证据包。全部来自磁盘上已有的东西，不做任何推断。
 * @param {object} o { root, rec, appRoot, dataRoot, logsDir, preview }
 */
export function buildEvidencePack({ root, rec, preview = [] }) {
  const verify = readVerify(root, rec?.id) || {};
  const rounds = Array.isArray(verify.rounds) ? verify.rounds : [];
  const html = [];
  const sev = {};

  const pack = {
    fixId: rec?.id || '',
    createdAt: rec?.createdAt || 0,
    status: rec?.status || '',
    question: rec?.question || '',
    answer: rec?.answer || '',
    target: rec?.target || {},
    proposal: rec?.proposal || {},
    protocol: rec?.protocol || { violations: [] },
    decision: rec?.decision || null,
    approval: rec?.approval ? { approvedAt: rec.approval.approvedAt || null, reruns: rec.decision?.reruns || 0 } : null,
    snapshot: rec?.snapshot || { files: [] },
    appliedAt: rec?.appliedAt || null,
    committedAt: rec?.committedAt || null,
    rounds: rounds.map((r) => ({ n: r.n, at: r.at, verify: r.verify ? { passed: r.verify.passed, failCount: r.verify.failCount, failureKey: r.verify.failureKey, items: (r.verify.items || []).map((i) => ({ verifier: i.verifier, file: i.file, status: i.status, detail: String(i.detail || '').slice(0, 800) })) } : null })),
    diffs: (rec?.proposal?.changes || []).map((c, i) => {
      const p = preview[i] || preview.find((x) => x && x.path === c.path) || {};
      return { path: c.path, scope: c.scope, level: c.level, intent: c.intent, stat: p.stat || null, lines: p.lines || [] };
    })
  };
  return pack;
}

/** 把证据包渲染成 Markdown（主产物；.docx 是分发形态）。 */
export function packToMarkdown(pack, narrative = null) {
  const L = [];
  const t = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '—');
  L.push(`# 修复报告：${pack.fixId}`);
  L.push('');
  L.push(`- 生成时间：${t(Date.now())}`);
  L.push(`- 状态：${statusLabel(pack.status)}`);
  L.push(`- 目标：${pack.target?.file || '—'}${pack.target?.line ? ':' + pack.target.line : ''}  ${pack.target?.ruleId || ''}`);
  L.push(`- 触发问题：${pack.question || '—'}`);
  if (pack.approval?.approvedAt) L.push(`- 人工批准于：${t(pack.approval.approvedAt)}`);
  if (pack.decision) {
    L.push(`- 人工决断：${decisionLabel(pack.decision.verdict)}${pack.decision.reason ? ` —— ${pack.decision.reason}` : ''}`);
    if (pack.decision.reruns) L.push(`- 闸②重跑次数：${pack.decision.reruns}`);
  }
  if (pack.committedAt) L.push(`- 落地时间：${t(pack.committedAt)}（快照 ${pack.snapshot?.files?.length || 0} 个文件，可回滚）`);
  L.push('');

  // 1. 问题出在哪
  L.push('## 1. 问题出在哪');
  L.push('');
  L.push(narrative?.where || pack.answer || '（未获得该信息）');
  L.push('');
  L.push(`**定位**：\`${pack.target?.file || '—'}\`${pack.target?.line ? ` 第 ${pack.target.line} 行` : ''}`);
  if (pack.proposal?.unverifiable?.length) {
    L.push('');
    L.push('> ⚠️ 本次改动**无法被验证器覆盖**的部分：');
    for (const u of pack.proposal.unverifiable) L.push(`> - ${u}`);
  }
  L.push('');

  // 2. 什么 bug 导致的
  L.push('## 2. 什么 bug 导致的');
  L.push('');
  L.push(narrative?.why || pack.proposal?.rootCause || '（未获得该信息）');
  if (pack.proposal?.residualRisk?.length) {
    L.push('');
    L.push('**残余风险**：');
    for (const r of pack.proposal.residualRisk) L.push(`- ${r}`);
  }
  L.push('');

  // 3. 修改意见
  L.push('## 3. 修改意见');
  L.push('');
  if (narrative?.how) { L.push(narrative.how); L.push(''); }
  if (!pack.diffs.length) {
    L.push('_本次没有改动任何文件（changes 为空 —— 可能是配置问题或使用问题，而不是代码问题）。_');
  }
  for (const d of pack.diffs) {
    L.push(`### ${d.path}${d.level ? `（${d.level}）` : ''}`);
    L.push('');
    if (d.intent) L.push(`**意图**：${d.intent}`);
    if (d.stat) L.push(`**规模**：+${d.stat.added} / -${d.stat.removed} 行（原 ${d.stat.oldLines} 行）`);
    L.push('');
    if (d.lines?.length) {
      L.push('```diff');
      for (const ln of d.lines) {
        const mark = ln.t === '+' ? '+' : ln.t === '-' ? '-' : ' ';
        L.push(`${mark}${String(ln.n).padStart(5)} | ${ln.s}`);
      }
      L.push('```');
      L.push('');
    }
  }
  if (pack.proposal?.rollback) {
    L.push(`**回滚方式**：${pack.proposal.rollback}`);
    L.push('');
  }
  L.push('### 验证结果');
  L.push('');
  if (!pack.rounds.length) {
    L.push('_没有验证记录。_');
  } else {
    L.push('| 轮次 | 结果 | 失败项 |');
    L.push('|---|---|---|');
    for (const r of pack.rounds) {
      const v = r.verify;
      L.push(`| ${r.n} | ${v ? (v.passed ? '通过' : `失败（${v.failCount} 项）`) : '—'} | ${v && !v.passed ? (v.failureKey || '').replace(/\|/g, ' / ') : '—'} |`);
    }
    L.push('');
    for (const r of pack.rounds) {
      const bad = (r.verify?.items || []).filter((i) => i.status === 'fail' || i.status === 'skip');
      if (!bad.length) continue;
      L.push(`**第 ${r.n} 轮的失败/跳过明细**：`);
      for (const i of bad) L.push(`- [${i.verifier}] ${i.file} → ${i.status}：${String(i.detail || '').split('\n')[0]}`);
      L.push('');
    }
  }

  // 4. 容易踩的坑
  L.push('## 4. 容易踩的坑');
  L.push('');
  if (narrative?.pitfalls) { L.push(narrative.pitfalls); L.push(''); }
  if (pack.protocol?.violations?.length) {
    L.push('**协议闸命中项**（这些是修复过程中被判为"要小心"的地方）：');
    for (const v of pack.protocol.violations) L.push(`- [${v.code}/${v.level}] ${v.title}${v.detail ? ` —— ${v.detail}` : ''}`);
    L.push('');
  }
  const reruns = pack.decision?.reruns || 0;
  if (reruns > 0) {
    L.push(`**闸②重跑了 ${reruns} 次** —— 说明这个验证本身有抖动，接手时不要把它当稳定信号。`);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('_本报告由「自动修复」模块生成。所有引用均可在审计记录、日志与改动 diff 中回溯。_');
  L.push('');
  return L.join('\n');
}

function statusLabel(s) {
  return ({ proposed: '待批准', applied: '已入暂存区', verifying: '自验中', verified: '待决断', committed: '已落地', discarded: '已丢弃', failed: '失败' })[s] || s || '—';
}
function decisionLabel(v) {
  return ({ accept: '通过并落地', reject: '丢弃', rework: '再改一句' })[v] || v || '—';
}

/** 报告叙事化的 prompt（模型只能引用证据包内容）。 */
export function buildReportPrompt(pack) {
  const sys = [
    '你在为一次**代码修复**写交接报告，读者是**下一位要接手修改的人**。',
    '',
    '严格要求（违反则报告作废）：',
    '1. **只允许引用下面证据包里实际存在的内容**。证据包里没有的，一律写"未获得该信息"。',
    '2. 不要编造日志行、不要编造代码行、不要猜测没记录过的现象。',
    '3. 引用要落到具体位置：文件名 + 行号 / 日志时间戳 / 第几轮验证。',
    '4. 语言平实，面向"接手的人"，重点是让他少踩坑，不是写给领导看的汇报。',
    '',
    '输出严格 JSON（不要围栏）：',
    JSON.stringify({
      where: '第一段：问题出在哪（现象、触发条件、影响面、涉及文件与行号）',
      why: '第二段：什么 bug 导致的（从现象推到根因的链条，以及原来的写法为什么错）',
      how: '第三段：修改意见（改了什么、为什么这么改、有没有更稳的替代方案）',
      pitfalls: '第四段：容易踩的坑（这次踩过的、下一位可能踩的、以及验证覆盖不到的地方）'
    }, null, 1)
  ].join('\n');
  const user = [
    '── 证据包（唯一可信来源）──',
    JSON.stringify({
      fixId: pack.fixId, status: pack.status, target: pack.target, question: pack.question,
      diagnosis: pack.answer, proposal: pack.proposal, protocol: pack.protocol,
      verifyRounds: pack.rounds, diffs: pack.diffs.map((d) => ({ path: d.path, level: d.level, intent: d.intent, stat: d.stat, lines: (d.lines || []).slice(0, 200) })),
      decision: pack.decision
    }, null, 1)
  ].join('\n');
  return { sys, user };
}

/** 解析报告叙事化结果（缺字段不致命，用空串让 Markdown 走"未获得该信息"）。 */
export function parseReport(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s);
    return { where: String(o.where || ''), why: String(o.why || ''), how: String(o.how || ''), pitfalls: String(o.pitfalls || '') };
  } catch { return null; }
}

// ── Markdown → .docx ─────────────────────────────────────────────────────

const XML_ESC = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // 控制字符会让 Word 直接报"文件损坏"
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function run(text, { bold = false, code = false, size = 22 } = {}) {
  const rpr = `<w:rPr>${bold ? '<w:b/>' : ''}${code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  return `<w:r>${rpr}<w:t xml:space="preserve">${XML_ESC(text)}</w:t></w:r>`;
}

function para(runs, { before = 60, after = 60, indent = 0 } = {}) {
  const ind = indent ? `<w:ind w:left="${indent}"/>` : '';
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${ind}</w:pPr>${runs}</w:p>`;
}

/** 极简 Markdown → OOXML 段落。只支持标题/列表/代码块/粗体，够用且不会把文件搞坏。 */
export function markdownToDocumentXml(md) {
  const out = [];
  const lines = String(md ?? '').split('\n');
  let inCode = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    if (/^```/.test(line.trim())) { inCode = !inCode; continue; }
    if (inCode) { out.push(para(run(line || ' ', { code: true, size: 18 }), { before: 0, after: 0 })); continue; }
    if (/^#\s+/.test(line)) { out.push(para(run(line.replace(/^#\s+/, ''), { bold: true, size: 32 }), { before: 240, after: 120 })); continue; }
    if (/^##\s+/.test(line)) { out.push(para(run(line.replace(/^##\s+/, ''), { bold: true, size: 26 }), { before: 200, after: 100 })); continue; }
    if (/^###\s+/.test(line)) { out.push(para(run(line.replace(/^###\s+/, ''), { bold: true, size: 24 }), { before: 160, after: 80 })); continue; }
    if (/^---+\s*$/.test(line)) { out.push(para(run('', {}), { before: 120, after: 120 })); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const indent = Math.floor((line.match(/^\s*/) || [''])[0].length / 2) * 240;
      out.push(para(run('• ' + line.replace(/^\s*[-*]\s+/, '')), { indent: 240 + indent, before: 20, after: 20 }));
      continue;
    }
    if (/^\s*>\s?/.test(line)) { out.push(para(run(line.replace(/^\s*>\s?/, ''), { size: 20 }), { indent: 360, before: 40, after: 40 })); continue; }
    // 行内 **粗体**（只处理最简单的情形）
    const segs = line.split(/(\*\*[^*]+\*\*)/g).filter((x) => x !== '');
    if (segs.length > 1) {
      out.push(para(segs.map((s) => (/^\*\*[^*]+\*\*$/.test(s) ? run(s.slice(2, -2), { bold: true }) : run(s))).join('')));
      continue;
    }
    out.push(para(run(line)));
  }
  return out.join('');
}

/** 最小 OOXML 包装 → 完整 .docx Buffer。 */
export function buildDocx(md) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${markdownToDocumentXml(md)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return zipStore([
    ['[Content_Types].xml', Buffer.from(contentTypes, 'utf8')],
    ['_rels/.rels', Buffer.from(rels, 'utf8')],
    ['word/document.xml', Buffer.from(documentXml, 'utf8')]
  ]);
}

// ── 自实现 ZIP writer（deflate + CRC32），与 src/market.js 同一套写法 ──

function makeCrc32() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
}

export function zipStore(entries) {
  const crc32 = makeCrc32();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(String(name), 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 6 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, payload);

    central.push({ nameBuf, crc, method, compSize: payload.length, rawSize: data.length, offset });
    offset += lfh.length + nameBuf.length + payload.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(c.method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(c.crc, 16);
    cdh.writeUInt32LE(c.compSize, 20);
    cdh.writeUInt32LE(c.rawSize, 24);
    cdh.writeUInt16LE(c.nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(c.offset, 42);
    chunks.push(cdh, c.nameBuf);
    offset += cdh.length + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

/** 从日志目录里按关键字抓片段（给证据包用）。 */
export function grepLogs(logsDir, keywords, { maxFiles = 3, maxLines = 40 } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(logsDir).filter((n) => /\.log$/i.test(n)).sort().reverse().slice(0, maxFiles); }
  catch { return out; }
  const res = keywords.filter(Boolean).map((k) => String(k).slice(0, 60));
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(logsDir, n), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < maxLines; i++) {
      if (res.some((k) => lines[i].includes(k))) hits.push(`${i + 1}| ${lines[i].slice(0, 300)}`);
    }
    if (hits.length) out.push({ file: n, hits });
  }
  return out;
}

export { readJsonSafe };

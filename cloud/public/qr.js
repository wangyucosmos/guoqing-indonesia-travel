/* 极简二维码生成器：字节模式，纠错等级 M，版本 1–10 自动选。
 * 为什么自己写：调第三方二维码网站会产生外部请求，大陆网络下不可靠，
 * 而且等于把小组邀请密钥发给了别人的服务器。这里全在本地算。
 * 输出布尔矩阵，由调用方画成 SVG。 */

const EC_M = {                       // 版本: [每块纠错码字, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
  1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44]
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};
const dataCapacity = v => {
  const [, g1b, g1d, g2b, g2d] = EC_M[v];
  return g1b * g1d + g2b * g2d;
};

/* ---------- GF(256) ---------- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x <<= 1; if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                    // 乘 x
      next[j + 1] ^= mul(poly[j], EXP[i]);   // 乘 α^i —— 系数按降幂排，gen[0] 必须是 1
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], factor);
  }
  return res.slice(data.length);
}

/* ---------- BCH（格式信息 / 版本信息） ---------- */
function bch(data, poly, bits) {
  let d = data << bits;
  const polyBits = 32 - Math.clz32(poly);
  while (32 - Math.clz32(d) >= polyBits) d ^= poly << (32 - Math.clz32(d) - polyBits);
  return (data << bits) | d;
}
const formatBits = mask => (bch((0b00 << 3) | mask, 0b10100110111, 10) | (0b00 << 13 | mask << 10)) ^ 0b101010000010010;
const versionBits = v => (v << 12) | bch(v, 0b1111100100101, 12);

/* ---------- 主流程 ---------- */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error('内容太长，超出二维码版本 10 的容量');

  const size = version * 4 + 17;
  const [ecLen, g1b, g1d, g2b, g2d] = EC_M[version];
  const countBits = version <= 9 ? 8 : 16;

  /* 位流 */
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  const cap = dataCapacity(version) * 8;
  push(0, Math.min(4, cap - bits.length));            // 结束符
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8)
    codewords.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCapacity(version); i++) codewords.push(PAD[i % 2]);

  /* 分块 + 纠错 */
  const blocks = [], ecBlocks = [];
  let p = 0;
  for (let i = 0; i < g1b + g2b; i++) {
    const len = i < g1b ? g1d : g2d;
    const chunk = Uint8Array.from(codewords.slice(p, p + len));
    p += len;
    blocks.push(chunk);
    ecBlocks.push(rsEncode(chunk, ecLen));
  }
  const final = [];
  for (let i = 0; i < Math.max(g1d, g2d); i++)
    for (const b of blocks) if (i < b.length) final.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) final.push(b[i]);

  /* 画矩阵 */
  const m = Array.from({ length: size }, () => new Array(size).fill(null));  // null = 数据区
  const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; };

  const finder = (r, c) => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const inSquare = i >= 0 && i <= 6 && j >= 0 && j <= 6;
      const dark = inSquare &&
        (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
      set(r + i, c + j, dark ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {                 // 定位图案
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  for (const r of ALIGN[version]) for (const c of ALIGN[version]) {   // 校正图案
    if ((r < 8 && c < 8) || (r < 8 && c > size - 9) || (r > size - 9 && c < 8)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++)
      set(r + i, c + j, (Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0)) ? 1 : 0);
  }
  m[size - 8][8] = 1;                                   // 固定的深色模块

  // 格式信息的两份拷贝。下标 i 对应第 (14-i) 位 —— 高位在前，
  // 第二份只占 7 个纵向格（size-8 那格是固定深色模块，不能被覆盖）。
  const fmtCells = [];
  for (let i = 0; i < 15; i++) {
    const a = i < 6 ? [8, i] : i < 8 ? [8, i + 1] : i < 9 ? [7, 8] : [14 - i, 8];
    const b = i < 7 ? [size - 1 - i, 8] : [8, size - 15 + i];
    fmtCells.push([a, b]);
    m[a[0]][a[1]] = 0; m[b[0]][b[1]] = 0;
  }
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1, r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit; m[r][size - 11 + c] = bit;
    }
  }

  /* 数据按 Z 字形填入 */
  let idx = 0, bitIdx = 0, upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                               // 跳过竖向定位列
    for (let n = 0; n < size; n++) {
      const row = upward ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (m[row][c] !== null) continue;
        let bit = 0;
        if (idx < final.length) bit = (final[idx] >> (7 - bitIdx)) & 1;
        if (++bitIdx === 8) { bitIdx = 0; idx++; }
        m[row][c] = bit;
      }
    }
    upward = !upward;
  }

  /* 选掩码：算 4 项罚分取最低 */
  const MASK = [
    (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0, (r, c) => (((r / 2) | 0) + ((c / 3) | 0)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) reserved[r][c] = true; };
  for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
    mark(i, j); mark(i, size - 7 + j); mark(size - 7 + i, j);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const r of ALIGN[version]) for (const c of ALIGN[version]) {
    if ((r < 8 && c < 8) || (r < 8 && c > size - 9) || (r > size - 9 && c < 8)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) mark(r + i, c + j);
  }
  for (const [a, b] of fmtCells) { mark(a[0], a[1]); mark(b[0], b[1]); }
  mark(size - 8, 8);
  if (version >= 7) for (let i = 0; i < 18; i++) {
    const r = Math.floor(i / 3), c = i % 3;
    mark(size - 11 + c, r); mark(r, size - 11 + c);
  }

  let best = null, bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const g = m.map((row, r) => row.map((v, c) => reserved[r][c] ? v : (MASK[mk](r, c) ? v ^ 1 : v)));
    const fb = formatBits(mk);
    fmtCells.forEach(([a, b], i) => {
      const bit = (fb >> (14 - i)) & 1;
      g[a[0]][a[1]] = bit; g[b[0]][b[1]] = bit;
    });
    g[size - 8][8] = 1;
    const s = penalty(g, size);
    if (s < bestScore) { bestScore = s; best = g; }
  }
  return best.map(row => row.map(Boolean));
}

function penalty(g, size) {
  let score = 0;
  const runScore = line => {
    let s = 0, run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += run - 2; run = 1; }
    }
    if (run >= 5) s += run - 2;
    return s;
  };
  for (let i = 0; i < size; i++) {
    score += runScore(g[i]);
    score += runScore(g.map(r => r[i]));
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = g[r][c];
    if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3;
  }
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hit = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
  for (let i = 0; i < size; i++) {
    const row = g[i], col = g.map(r => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (hit(row, j, P1) || hit(row, j, P2)) score += 40;
      if (hit(col, j, P1) || hit(col, j, P2)) score += 40;
    }
  }
  const dark = g.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
  return score;
}

/** 画成 SVG 字符串。quiet = 静区格数，标准要求 4 格。 */
export function qrSvg(text, { size = 220, quiet = 4, dark = '#111', light = '#fff' } = {}) {
  const m = qrMatrix(text);
  const n = m.length, total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="小组邀请二维码">` +
    `<rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

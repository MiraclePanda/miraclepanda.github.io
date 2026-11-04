// ホーム・1日の終わりの見出しに置く絵(インライン SVG)。夜明けの海と山、遠くへ続く道と、荷物を積んだ自転車。
// 色は css/style.css の .hero-art の中のクラスで塗るので、ダークモードでは夜明け前の色になる。
// 画像ファイルを持たない(外部の画像にも頼らない)ために SVG の文字列で持つ。

import { h } from './h.js';

const SVG = `<svg viewBox="0 0 760 240" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="夜明けの海と山へ続く道">
<defs>
  <linearGradient id="ha-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" class="ha-sky-top"/><stop offset="0.62" class="ha-sky-mid"/><stop offset="1" class="ha-sky-low"/>
  </linearGradient>
  <radialGradient id="ha-glow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" class="ha-glow-in"/><stop offset="1" class="ha-glow-out"/>
  </radialGradient>
</defs>
<rect width="760" height="240" fill="url(#ha-sky)"/>
<g class="ha-stars"><circle cx="60" cy="30" r="1.2"/><circle cx="140" cy="62" r="0.9"/><circle cx="250" cy="22" r="1.1"/><circle cx="610" cy="40" r="1.3"/><circle cx="700" cy="78" r="0.9"/><circle cx="520" cy="18" r="0.8"/></g>
<circle cx="250" cy="150" r="90" fill="url(#ha-glow)"/>
<circle cx="250" cy="150" r="26" class="ha-sun"/>
<path class="ha-far" d="M330 150 L390 112 L430 128 L486 86 L540 120 L590 100 L660 134 L760 108 L760 150 Z"/>
<rect y="148" width="760" height="40" class="ha-sea"/>
<g class="ha-wave"><path d="M40 160 h70 M150 170 h50 M300 164 h90 M420 176 h60 M90 182 h40"/></g>
<path class="ha-near" d="M420 150 C470 128 520 118 570 136 C620 112 680 102 760 120 L760 240 L380 240 Z"/>
<path class="ha-shore" d="M0 188 C120 180 250 196 380 184 C460 176 520 168 600 172 L760 168 L760 240 L0 240 Z"/>
<path class="ha-road" d="M300 240 C360 214 420 206 470 196 C520 186 560 178 600 170 L606 171 C566 182 528 192 482 204 C430 216 390 226 360 240 Z"/>
<path class="ha-road-line" d="M330 240 C385 218 432 209 476 200 C520 190 560 181 603 171"/>
<g class="ha-bike" transform="translate(500 166) scale(0.8)">
  <circle cx="0" cy="22" r="11"/><circle cx="36" cy="22" r="11"/>
  <path d="M0 22 L14 6 L32 6 L36 22 M14 6 L18 22 L32 6 M30 0 L34 0 M14 6 L12 0 L18 0"/>
  <rect class="ha-bag" x="-8" y="4" width="14" height="11" rx="2"/>
  <rect class="ha-bag" x="11" y="-2" width="16" height="6" rx="2"/>
  <path class="ha-rider" d="M17 -2 L24 -20 L32 2 M24 -20 L34 -12 L32 -2"/>
  <circle class="ha-rider-head" cx="22" cy="-26" r="5"/>
</g>
<g class="ha-bird"><path d="M560 60 q6 -6 12 0 q6 -6 12 0"/><path d="M600 76 q5 -5 10 0 q5 -5 10 0"/></g>
</svg>`;

/** 冒険の旅立ちの絵の帯。children は絵の上に重ねる文字。 */
export function HeroArt({ children, compact = false }) {
  return h('header', { className: `hero${compact ? ' compact' : ''}` },
    h('div', { className: 'hero-art', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: SVG } }),
    h('div', { className: 'hero-text' }, children));
}

// Three.jsをCDNから読み込むための単一の再エクスポート窓口。
//
// import mapではなくCDN URLへの直接importを使っている(index.htmlのコメント
// 参照): 一部の管理・サンドボックス環境ではimport mapの解決がポリシーで
// ブロックされる場合がある一方、素のURL importはどの環境でも(importmapを
// 一切介さず)確実に動作するため。
//
// このファイルだけがCDN URLを直接記述する窓口になっている。
// テスト実行時は test/lib/prepare-site.mjs がこの1行のURLだけを
// ローカルvendor(test/vendor/three.module.js)への相対パスに書き換える。
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js';

export default THREE;

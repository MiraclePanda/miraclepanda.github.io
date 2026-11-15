// Three.js の単一の再エクスポート窓口。
//
// Three.js はリポジトリに同梱した vendor/three/(npm の three@0.186.0 の build/ をそのまま置いたもの)
// から相対 URL で読む。以前は CDN(jsDelivr)の URL を直接 import していたが、CDN の障害でアプリが
// 起動しなくなる・改ざんを検知できない・テストは差し替えた複製で動くので本番の読み込み経路を
// 確かめられない、の3点から同梱に変えた(レビュー Q4)。ビルドは要らない(ES モジュールのまま置くだけ)。
// 版を上げるときは tools/update-vendor.sh を実行する。
//
// import map は使わない(index.html のコメント参照: 一部の管理・サンドボックス環境ではポリシーで
// ブロックされる)。相対 URL の import はどの環境でも動く。
import * as THREE from '../../vendor/three/three.module.js';

export default THREE;

/**
 * WebGPU 版の three.js(WebGPURenderer・ノードマテリアル・TSL を含む)を読み込む。
 * WebGPU で描くときだけ呼ぶ(重いので、使わない端末では読まない。gpuBackend.js)。
 * 中身は上と同じ three.core.js を共有するので、THREE で作った物をそのまま描ける。
 */
export function loadThreeWebGPU() {
  return import('../../vendor/three/three.webgpu.js');
}

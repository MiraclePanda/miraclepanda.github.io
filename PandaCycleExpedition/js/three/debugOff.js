// 確認用: URL の ?off=photo,trees,post のように、景色の要素を外して描く(実機でどれが重いかを fps で見比べるため)。
// ?perf=1 と一緒に使う。外した要素は ?perf=1 の表示の末尾に出る。ふだんの走行では使わない。
//
//   photo   地面の航空写真        pano    富士山・大島などの遠景
//   post    光のにじみ・色の整え   shadow  影
//   trees   森の木                bld     建物
//   tunnel  トンネルの筒の中の地面を描かない処理

export const OFF_KEYS = ['photo', 'pano', 'post', 'shadow', 'trees', 'bld', 'tunnel'];

/** URL の検索文字列(location.search)から、外す要素の Set を返す。知らない名前は無視する。 */
export function parseOffParam(search) {
  let v = null;
  try {
    v = new URLSearchParams(search ?? '').get('off');
  } catch {
    v = null;
  }
  return new Set((v ?? '').split(',').map((x) => x.trim()).filter((x) => OFF_KEYS.includes(x)));
}

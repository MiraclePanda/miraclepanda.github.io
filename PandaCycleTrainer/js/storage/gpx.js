// GPX ファイルの読み込み(実在コース走行用)。
// ユーザーが Strava・RideWithGPS・Garmin Connect などで作成/書き出した GPX から、
// 経路の点列(緯度・経度・標高)とコース名だけを取り出す純粋関数。
// Node の単体テストから使えるよう DOMParser には頼らず、GPX で使われる範囲の
// 単純な要素(trkpt / rtept / ele / name)を正規表現で読む。
// 座標は勾配プロファイルと道路形状の生成にだけ使い、TCX 書き出しには一切含めない
// (要件定義書6章、tcx.js のヘッダコメント参照)。

const NAME_RE = /<(?:[\w-]+:)?name>([\s\S]*?)<\/(?:[\w-]+:)?name>/;
const ELE_RE = /<(?:[\w-]+:)?ele>\s*([-+0-9.eE]+)\s*<\/(?:[\w-]+:)?ele>/;

function pointRegex(tag) {
  // <trkpt lat=".." lon=".."/> と <trkpt ...>...</trkpt> の両方に一致させる
  return new RegExp(
    `<(?:[\\w-]+:)?${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>)`,
    'g',
  );
}

function attrNumber(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`));
  if (!m) return NaN;
  return Number(m[1]);
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

function readPoints(text, tag) {
  const points = [];
  for (const m of text.matchAll(pointRegex(tag))) {
    const lat = attrNumber(m[1], 'lat');
    const lon = attrNumber(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const eleMatch = m[2] ? m[2].match(ELE_RE) : null;
    const ele = eleMatch ? Number(eleMatch[1]) : NaN;
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  return points;
}

/**
 * GPX テキストを解析する。
 * トラック(trkpt、全セグメントを順に連結)を優先し、無ければルート(rtept)を使う。
 * @param {string} text GPX ファイルの中身
 * @returns {{ name: string, points: {lat: number, lon: number, ele: number|null}[] }}
 * @throws {Error} GPX でない、または経路の点が2つ未満のとき(メッセージは画面表示用)
 */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<(?:[\w-]+:)?gpx\b/.test(text)) {
    throw new Error('GPX ファイルではありません。');
  }
  // 経路点の中の <name> をコース名と取り違えないよう、点を除いた残りから名前を探す
  const withoutPoints = text.replace(pointRegex('trkpt'), '').replace(pointRegex('rtept'), '');
  const nameMatch = withoutPoints.match(NAME_RE);
  const name = nameMatch ? decodeXml(nameMatch[1]) : '';

  let points = readPoints(text, 'trkpt');
  if (points.length < 2) points = readPoints(text, 'rtept');
  if (points.length < 2) {
    throw new Error('GPX にコースの経路(トラックまたはルート)が見つかりません。');
  }
  return { name, points };
}

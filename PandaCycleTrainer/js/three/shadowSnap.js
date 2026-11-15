// 影の範囲の中心を、影の画素(テクセル)の刻みに丸める(レビュー R6)。純粋な計算(Node でテストできる)。
//
// 実在の街・熱海・上野では、影を描く範囲(太陽の影カメラ)がライダーについて動く。中心が連続して動くと、
// 影の画素の境目が地面の上を滑り、建物や木の影の縁が走行中に細かくちらつく。影カメラの向き(太陽の方向)に
// 垂直な2軸で、中心を影の1画素分の刻みに丸めると、画素の境目が地面に対して止まり、ちらつかない。
// 追加の描画はない。

/**
 * @param {number} x 影の範囲の中心にしたい点(ライダーの位置)
 * @param {number} y
 * @param {number} z
 * @param {{x:number, y:number, z:number}} sunDir 太陽の方向(影カメラの位置 = 中心 + sunDir × 距離)
 * @param {number} texelM 影の1画素の大きさ(m)= 影カメラの幅 ÷ 影の画素数
 * @returns {[number, number, number]} 丸めた中心
 */
export function snapShadowCenter(x, y, z, sunDir, texelM) {
  if (!(texelM > 0)) return [x, y, z];
  // 影カメラの軸(three.js の lookAt と同じ: z = 太陽の方向、x = 上 × z、y = z × x。上は (0, 1, 0))
  let zl = Math.hypot(sunDir.x, sunDir.y, sunDir.z) || 1;
  const zx = sunDir.x / zl;
  const zy = sunDir.y / zl;
  const zz = sunDir.z / zl;
  // x = (0,1,0) × z = (zz, 0, -zx)
  let ax = zz;
  let ay = 0;
  let az = -zx;
  zl = Math.hypot(ax, az);
  if (zl < 1e-6) {
    // 太陽が真上: どちらの向きでもよい
    ax = 1;
    az = 0;
  } else {
    ax /= zl;
    az /= zl;
  }
  // y = z × x
  const bx = zy * az - zz * ay;
  const by = zz * ax - zx * az;
  const bz = zx * ay - zy * ax;
  const a = x * ax + y * ay + z * az;
  const b = x * bx + y * by + z * bz;
  const da = Math.round(a / texelM) * texelM - a;
  const db = Math.round(b / texelM) * texelM - b;
  return [x + ax * da + bx * db, y + ay * da + by * db, z + az * da + bz * db];
}

/** 太陽の影の範囲(DirectionalLight の影カメラ)の1画素の大きさ(m)。 */
export function shadowTexelM(light) {
  const cam = light.shadow.camera;
  return (cam.right - cam.left) / light.shadow.mapSize.x;
}

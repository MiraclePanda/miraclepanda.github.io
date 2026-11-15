// CYCPLUS DC1 実機確認が必要な値をまとめた設定ファイル。
// 要件定義書 8章「実装前に実機確認が必須な事項」に対応する暫定値。
// 実機での検証後、このファイルの値のみを更新すれば良いように分離している。

export const DeviceProfile = {
  // 送信grade値のクランプ範囲(%)。
  // 暫定値: 一般的なスマートトレーナーのSimulation Modeで
  // よく見られる範囲(-10%〜+20%)を仮置き。
  // TODO(要実機確認): CYCPLUS DC1の実際の対応grade範囲に置き換える。
  GRADE_MIN_PERCENT: -10,
  GRADE_MAX_PERCENT: 20,

  // ERGモード時の目標パワークランプ範囲(W)。
  // TODO(要実機確認): 実機のSupported Power Range特性値で上書きする。
  ERG_MIN_WATTS: 0,
  ERG_MAX_WATTS: 1000,

  // grade再送信の閾値(%)。この変化量を超えた場合のみ送信する。
  // 当初は 0.5% だったが、0.5% の段差は 75kg・20km/h で約20W に相当し、DC1 の実機で
  // 「走行中に唐突に負荷が変わる」と報告されたため 0.1% に下げた(2026-10)。
  // 走行中は毎フレーム呼ばれるが、CommandQueue#enqueueLatest で最新値だけが送られる。
  GRADE_RESEND_THRESHOLD_PERCENT: 0.1,

  // ERG目標W再送信の閾値(W)。
  ERG_RESEND_THRESHOLD_WATTS: 3,

  // Control Point コマンドの最大リトライ回数。
  COMMAND_MAX_RETRIES: 3,
  COMMAND_RETRY_DELAY_MS: 300,
  // indicate応答を待つタイムアウト。
  COMMAND_RESPONSE_TIMEOUT_MS: 4000,
  // 体重の書き込み(User Data Service)を待つ上限(ms)。応答の無い機種でコマンドのキューを止めないため。
  // TODO(要実機確認): DC1 が User Data Service を持つか、持つなら何秒で応答するか。
  USER_WEIGHT_TIMEOUT_MS: 5000,
  // TODO(要実機確認): Start or Resume の直後や、初回の負荷設定に失敗して制御権を取り直す前に
  // 置く待ち時間(ms)。直後の Simulation Parameters を一時的に拒否する機種があるため。
  START_SETTLE_DELAY_MS: 400,

  // 走行終了時(接続は維持)に、負荷0の後で Stop or Pause(Pause, 0x02)も送るか。
  // 次の走行開始時は Request Control → Start or Resume からやり直すので、送らなくても動く。
  // TODO(要実機確認): DC1 が Pause を受けたあとも接続を保ち、次の Start or Resume で
  // 負荷制御に戻るか。戻らない場合は false にする(負荷0のまま待機する)。
  END_SESSION_SEND_PAUSE: true,

  // 勾配・ERG 目標の送信の最小間隔(ms)。勾配が変わり続ける区間では、応答が返るたびに次を送ると
  // 毎秒何回もの書き込みになる(レビュー Q9 d)。間に来た値は CommandQueue#enqueueLatest で最新だけ残る。
  // TODO(要実機確認): DC1 がこれより短い間隔の負荷変更を受け付けるか、逆に長くすべきか。
  CONTROL_TARGET_MIN_INTERVAL_MS: 200,

  // 走行中に接続が切れたとき、同じ機器へ自動でつなぎ直す回数と間隔(ms)。機器の選択画面は出さない
  // (レビュー F2)。全部失敗したら再接続のダイアログを出す。
  // TODO(要実機確認): DC1 が切断から何秒で再び接続を受け付けるか。
  AUTO_RECONNECT_ATTEMPTS: 3,
  AUTO_RECONNECT_DELAY_MS: 2000,

  // Indoor Bike Simulation Parametersに送る固定定数。
  // 屋内走行のため風速は常に0とする。
  WIND_SPEED_MPS: 0,
};

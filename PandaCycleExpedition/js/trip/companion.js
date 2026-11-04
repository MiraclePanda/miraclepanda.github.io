// 道連れ: 同じ方向へ走るサイクリストがしばらく並走し、楽しい話を一方的にしてくれる。純粋ロジックのみ(DOM なし)。
//
// 目的は「会話できる楽なペースで長く気持ちよく漕ぐ」こと。競争・記録・罰はない。
// 踏みすぎる(パワーが「話せるペース」を超える)と道連れは話を一休みし、楽なペースに戻ると続きから話す。
// 話せるペースの上限は FTP の 75% × 体力の目安(sustainableWatts)。疲れているほど低くなる。
// 道連れの出現は区間・日・seed から決定的に決め、身の上話の進み具合は trip.companions に残す(再会すると続きを話す)。
// 物理・トレーナーへの指示には使わない(表示だけ)。

import { hashSeed, mulberry32 } from './dayEvents.js';
import { sustainableWatts } from './body.js';

/** 会話のペース・間合い(すべて実時間の秒)。 */
export const TALK = {
  /** 話せるペースの上限 = 体力の目安パワー × この割合 */
  EASY_RATIO: 0.75,
  /** 上限を超えてこの秒数続くと、話が一休みになる */
  HARD_AFTER_SEC: 5,
  /** 一休み中に上限以下へ戻ってこの秒数続くと、話を再開する */
  RESUME_AFTER_SEC: 4,
  /** 1行を表示しておく秒数 */
  LINE_SEC: 7,
  /** 話題と話題のあいだの間(景色を見ながら黙って走る) */
  GAP_SEC: 35,
  /** この距離(m)先までにある地点の話を、ほかの話題より先にする */
  PLACE_AHEAD_M: 700,
};

/** 道連れの顔ぶれ。話し方・身の上話(chapters、再会するたびに1章ずつ進む)は人ごとに違う。 */
export const COMPANIONS = [
  {
    id: 'yamamoto',
    name: '山本さん',
    who: '定年後に日本一周中の元郵便屋さん',
    intro: ['やあ、こんにちは。荷物を積んだ自転車とは珍しい、同じ旅人ですね。', 'しばらくご一緒してもいいですか。のんびり行きましょう。'],
    reunion: ['おや、また会いましたね!元気そうでなにより。', 'この前の話の続き、聞いてもらえますか。'],
    slowDown: 'ふう、ちょっと速いですね。私はこのくらいのペースが好きでして…',
    resume: 'ああ、ちょうどいい。さて、どこまで話しましたっけ。',
    farewell: ['私はこの先で少し休んでいきます。', '楽しかった。またどこかの道で会いましょう。お気をつけて!'],
    chapters: [
      ['郵便屋を40年やってましてね。毎日同じ町を、赤いバイクで回ってたんです。', '定年の日に、今度は知らない町を走ってみたくなりまして。', 'それで自転車を買って、北海道の稚内から南へ下ってきたんですよ。'],
      ['旅に出て最初の夏は、とにかく坂がつらくてね。', '押して歩いていたら、畑のおばあさんがトマトを3つくれたんです。', 'あの甘さは忘れられません。それ以来、坂の途中で休むのが楽しみになりました。'],
      ['実は、配達していた町の人たちに、旅先から絵はがきを送っているんです。', '昔は届ける側、今は出す側。ポストを見るとつい手を合わせたくなります。', 'この前は、小学生だった子から「僕も郵便屋になりました」と返事が来ましてね。'],
      ['日本一周も、あと少しで最初の町に戻るんです。', 'でもね、ゴールしたら、今度は反対回りで行こうかと思ってまして。', '同じ道でも、向きが違えば別の景色ですから。'],
    ],
    topics: [
      ['郵便屋の勘ですが、海沿いの町は表札が潮風で色あせるのが早いんです。', 'だから新しい表札の家は、最近建て替えたか、お孫さんが生まれたか。そんなことを想像しながら走ると楽しいですよ。'],
      ['旅の楽しみは、その町の郵便局の風景印を集めることでして。', '局ごとに、名所が描かれた消印があるんです。スタンプ帳みたいなものですね。'],
    ],
  },
  {
    id: 'minami',
    name: 'ミナミさん',
    who: '休みのたびに少しずつ日本をつないで走る、大阪の会社員',
    intro: ['おっ、ええ荷物積んでるやん!どこまで行くん?', 'うちも同じ方向やねん。ちょっと一緒に走ろか。'],
    reunion: ['あれっ、また会うたな!これはもう運命やで。', 'ほな、この前の続き話すわ。'],
    slowDown: 'ちょ、ちょっと待って、速い速い!しゃべられへんやん…',
    resume: 'よっしゃ、このくらいがちょうどええわ。ほんで、なんの話やったっけ。',
    farewell: ['うち、この先の店でちょっと寄り道していくわ。', 'おおきに、楽しかったで!また道で会お!'],
    chapters: [
      ['うちな、会社の休みのたびに、前回やめた駅まで電車で戻って、そこから続きを走ってんねん。', '「日本を少しずつ線でつなぐ」って決めてな。', 'もう5年目やけど、まだ本州の半分くらいや。'],
      ['最初の旅は、大阪から和歌山の海沿いやってん。', 'お腹空きすぎて、道の駅のみかんを10個も買うて、全部その場で食べてもうた。', '店のおばちゃんに「あんた、大丈夫?」って本気で心配されたわ。'],
      ['会社の人には「なんで休みにわざわざ疲れに行くん?」って言われるねん。', 'でもな、走ったあとのご飯の美味しさを知ったら、もう戻られへん。', '最近は同僚も一人、自転車買うてん。布教成功や。'],
      ['実はな、来年はついに九州に渡る予定やねん。', 'フェリーで自転車ごと乗るの、ずっと楽しみにしてて。', '海の上で食べるカレーが美味しいらしいで。'],
    ],
    topics: [
      ['旅先で食べたもんで一番感動したんは、漁港の朝ごはんや。', 'ご飯と味噌汁と、さっきまで泳いでた魚。シンプルが一番やな。'],
      ['自転車旅の荷物な、最初は全部持っていきたなるねん。', 'でも結局使うのは、着替えと雨具と、おやつや。おやつは大事。'],
    ],
  },
  {
    id: 'haru',
    name: 'ハルさん',
    who: '夏休みに日本一周に挑戦中の、大学の自転車部員',
    intro: ['こんにちは!旅の方ですか?ぼくも日本一周の途中なんです!', 'よかったら一緒に走ってもいいですか?'],
    reunion: ['あっ!また会えましたね!うれしいです!', 'あれから色々あったんですよ、聞いてください!'],
    slowDown: 'うわ、ペース上がってますね…ちょっと息が…',
    resume: 'ふう、これなら話せます!えっと、それでですね。',
    farewell: ['ぼく、この先で部の先輩と待ち合わせなんです。', 'ありがとうございました!よい旅を!'],
    chapters: [
      ['自転車部に入ったのは、実は先輩の話がきっかけで。', '「日本一周すると、地図が自分の脚の記憶になる」って言われたんです。', 'それがかっこよくて、気づいたら入部届を出してました。'],
      ['旅の初日、パンクを3回もしちゃったんです。', '最後は直す道具もなくなって、途方に暮れてたら、自転車屋のおじいさんが店を開けてくれて。', 'お代はいいから、旅の話を聞かせてくれって。'],
      ['毎晩、日記をつけてるんです。その日一番うれしかったことを一つだけ書くルールで。', '雨の日も、何かしら見つかるんですよ。', '昨日は「コンビニのおにぎりがあったかかった」でした。'],
      ['夏休みが終わったら、部の後輩たちに旅の話をする約束なんです。', 'だから、いろんな人に会って、話のネタを集めてるんですよ。', 'あなたのことも話していいですか?荷物いっぱいのすごい旅人に会ったって!'],
    ],
    topics: [
      ['自転車部の合宿では、ひたすら峠を上るんです。', 'でも一人旅だと、景色がいいところで止まり放題。こっちのほうが好きかもしれません。'],
      ['旅の前に、地図に行きたい場所のシールを貼ったんです。', 'まだ半分も剥がせてないですけど、増える一方で。'],
    ],
  },
];

/** だれとでも出る話題: 食べ物・失敗談・旅の小ネタ・季節。 */
export const SHARED_TOPICS = [
  ['伊豆に来たら、金目鯛の煮付けは一度は食べたいですね。', '甘辛いタレがご飯に合うんですよ。'],
  ['温泉まんじゅうって、町ごとに少しずつ味が違うんです。', '食べ比べのために、つい店の前で止まっちゃいます。'],
  ['この前、雨具を宿に忘れて出発しちゃって。', '昼にスコールが来て、ずぶ濡れで食堂に入ったら、タオルを貸してもらえました。旅はだいたい人に助けられてます。'],
  ['港の近くの公園でお弁当を広げてたら、猫が寄ってきて。', 'ちょっと目を離したら、唐揚げが一個なくなってました。'],
  ['荷物は重いものを低く、真ん中に積むとふらつかないんです。', '水と食料は下のほう、寝袋は上。これだけで坂がずいぶん楽になりますよ。'],
  ['電車に自転車を積む輪行、慣れると楽しいですよ。', '袋に入れて駅のホームで待っていると、たいてい誰かに「どこまで?」って聞かれます。'],
  ['伊豆は秋がいちばん走りやすいって、地元の人が言ってました。', '海がまだ青くて、風がちょうど涼しいからだそうです。'],
  ['旅先の朝ごはんって、なんであんなにおいしいんでしょうね。', '前の日にたくさん走ったからかな。'],
  ['海沿いの道は、行きと帰りで海の見え方が全然違うんです。', '帰りに同じ道を走るのも、ちょっと楽しみなんですよ。'],
  ['昔の旅人は、この道を歩いて江戸から下田まで行ったそうです。', 'それに比べたら、自転車はずいぶん速い乗り物ですね。'],
];

/** 走っている場所の話(地点 id ごと。その地点に近づいたときに話す。逆向きに走っても同じ id で出る)。 */
export const PLACE_TOPICS = {
  nishikigaura: ['この先が錦ヶ浦。崖の上から相模灘が一望できますよ。', '昔は景勝地として、絵はがきにもよく描かれたそうです。'],
  taga: ['多賀は、熱海の中でも静かな海辺の町なんです。', '梅の時期は、山のほうがいい香りになりますよ。'],
  ajiro: ['網代は昔から干物の町でね。', '天気のいい日は、軒先にアジがずらっと並んでるんです。潮風で干すからおいしいって。'],
  'ajiro-shokudo': ['この先の食堂、干物定食がおすすめらしいですよ。', 'お腹がすいていたら、寄ってみてはどうですか。'],
  usami: ['宇佐美の海岸は、海水浴場にもなる広い浜なんです。', '夕方は海の向こうに初島が見えて、きれいですよ。'],
  ito: ['もうすぐ伊東。温泉の町です。', '川沿いに古い旅館が並んでいて、夜は灯りがきれいなんですよ。'],
  jogasaki: ['城ヶ崎海岸は、大昔の噴火の溶岩が海に流れ込んでできた崖なんです。', '吊り橋から見下ろすと、足がすくみますよ。'],
  izukogen: ['伊豆高原には、小さな美術館やカフェがたくさんあるんです。', '森の中に急に素敵なお店が出てくるから、つい寄り道しちゃいます。'],
  atagawa: ['熱川は、町のあちこちから湯けむりが上がってるんです。', '温泉の熱でバナナやワニを育ててる施設もあるとか。'],
  inatori: ['稲取は、金目鯛の水揚げで有名な港町なんです。', 'ひな祭りの「つるし飾り」も、ここが発祥だそうですよ。'],
  kawazu: ['河津は、早咲きの河津桜で有名なんです。', '2月には川沿いがピンクに染まって、人でいっぱいになります。'],
  shirahama: ['白浜の砂浜は、本当に白いんですよ。', '海の青とのコントラストが、南の島みたいなんです。'],
  shimoda: ['下田は、黒船が来た町として知られてます。', '港のまわりを歩くと、昔の洋館やなまこ壁が残ってるんですよ。'],
};

/** 天気が変わったときの話。 */
export const WEATHER_TOPICS = {
  sunny: ['晴れてきましたね!海がきらきらしてる。', 'こういう日は、走ってるだけで得した気分になります。'],
  cloudy: ['雲が出てきましたね。', 'でも、日差しが弱いほうが走るのは楽なんですよ。'],
  rain: ['降ってきましたね。', '雨の日の道は、匂いが変わるのが好きなんです。土と海の匂いがして。'],
  squall: ['うわっ、スコールだ!', 'こういう雨はすぐ抜けますよ。笑っちゃうくらい濡れるのも、旅の思い出です。'],
};

/** トンネルに入ったときのひとこと(1日1回)。 */
export const TUNNEL_TOPIC = ['トンネルの中は声が響きますね!', 'ちょっと涼しくて、気持ちいい。'];

/**
 * 旅の記録(日誌)に反応する話。前日に泊まった所・食べた物から作る。
 * @returns {string[][]}
 */
export function tripTopics(trip) {
  const out = [];
  const last = trip.log?.[trip.log.length - 1];
  if (last?.lodging?.name) {
    const k = last.lodging.kind;
    out.push(k === 'park' || k === 'camp'
      ? [`昨日は${last.lodging.name}でテントだったんですか?`, '星がきれいだったでしょう。外で寝た朝は、空気が違いますよね。']
      : [`昨日は${last.lodging.name}に泊まったんですか?`, 'いいなあ。旅の宿って、着いた瞬間がいちばんうれしいですよね。']);
  }
  const meal = [...(last?.meals ?? []), ...(trip.ride?.meals ?? [])].pop();
  if (meal?.name) out.push([`${meal.name}を食べたんですか!`, 'いいですね。旅先の名物は、その土地で食べるのがいちばんおいしい。']);
  if (trip.day >= 3) out.push([`もう旅の${trip.day}日目なんですね。`, '毎日少しずつでも、振り返ると遠くまで来てるものですよ。']);
  return out;
}

/**
 * 道連れの予定(区間・日・seed で決まる)。区間が短い・残りが少ないときは出ない。
 * 前に会って身の上話が残っている人を少し優先する(再会)。
 * @param {object} segment 区間
 * @param {object} trip 旅(tripId・day・companions)
 * @param {number} startM 今日この区間を走り始める地点(途中から再開したとき用)
 * @returns {{companion:object, joinM:number, leaveM:number, chapter:number, reunion:boolean} | null}
 */
export function planCompanion(segment, trip, startM = 0) {
  const rnd = mulberry32(hashSeed(`${trip.tripId}:companion:${segment.id}:${trip.day}`));
  const met = trip.companions ?? {};
  const unfinished = COMPANIONS.filter((c) => met[c.id] && (met[c.id].chapter ?? 0) < c.chapters.length);
  const pool = unfinished.length && rnd() < 0.6 ? unfinished : COMPANIONS;
  const companion = pool[Math.floor(rnd() * pool.length)];
  const joinM = Math.max(startM + 300, 800 + rnd() * 1200);
  const leaveM = Math.min(joinM + 9000 + rnd() * 8000, segment.lengthM - 700);
  if (leaveM - joinM < 2000) return null;
  const chapter = met[companion.id]?.chapter ?? 0;
  return { companion, joinM, leaveM, chapter, reunion: !!met[companion.id] };
}

/** 話せるペースの上限(W)。体力が落ちると下がる。 */
export function talkCeilingW(stamina, ftpW) {
  return Math.round(sustainableWatts(stamina, ftpW) * TALK.EASY_RATIO);
}

/**
 * 並走中の会話の進行。step() を毎フレーム呼ぶと、言うべき1行やできごとを返す。
 * 時間は実時間の秒で数える(早回し倍率に関係なく、読める速さで話す)。
 */
export class CompanionTalk {
  /**
   * @param {{plan:object, trip:object}} p planCompanion の結果と、走り始めの旅
   */
  constructor({ plan, trip }) {
    this.plan = plan;
    this.companion = plan.companion;
    this.phase = 'before'; // before → together → gone
    this.pace = 'easy'; // easy | hard(一休み中)
    this.chapter = plan.chapter;
    this.queue = []; // 今話している話題の残りの行
    this.lineLeft = 0; // 今の行をあと何秒表示するか
    this.gapLeft = 0; // 次の話題までの間
    this.text = null; // 今表示している行
    this.hardSec = 0;
    this.easySec = 0;
    this.toldPlaces = new Set();
    this.toldTunnel = false;
    this.lastWeather = null;
    this.togetherFromM = 0;
    // 話題の順: 旅の記録への反応 → 身の上話 → 本人の話 → 共通の話題(seed で並べ替え)、を交互に
    const rnd = mulberry32(hashSeed(`${trip.tripId}:talk:${trip.day}:${this.companion.id}`));
    const shared = SHARED_TOPICS.map((t) => [rnd(), t]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const own = [...this.companion.topics];
    this.agenda = [...tripTopics(trip)];
    const story = this.chapter < this.companion.chapters.length ? [{ story: this.chapter }] : [];
    // 身の上話は2つめの話題に入れる(早めに聞ける)
    this.agenda.splice(Math.min(1, this.agenda.length), 0, ...story);
    while (own.length || shared.length) {
      if (own.length) this.agenda.push(own.shift());
      if (shared.length) this.agenda.push(shared.shift());
      if (shared.length) this.agenda.push(shared.shift());
    }
  }

  /**
   * @param {{dtSec:number, powerW:number, ceilingW:number, segM:number, moving:boolean,
   *          weatherKind?:string, inTunnel?:boolean, places?:{id:string, atM:number}[]}} p
   *   moving: 走っている(一時停止・分かれ道で止まっていない)。places: 区間の地点(atM 昇順)
   * @returns {{joined?:boolean, left?:boolean, togetherM?:number, chapterDone?:number, say?:string}}
   */
  step({ dtSec, powerW, ceilingW, segM, moving, weatherKind, inTunnel, places = [] }) {
    const out = {};
    if (this.phase === 'gone') { this.goneLeft -= dtSec; return out; }
    if (this.phase === 'before') {
      if (!moving || segM < this.plan.joinM) return out;
      this.phase = 'together';
      this.togetherFromM = segM;
      this.lastWeather = weatherKind;
      out.joined = true;
      this._startTopic(this.plan.reunion ? this.companion.reunion : this.companion.intro);
      return this._sayNext(out);
    }
    // together
    if (segM >= this.plan.leaveM) {
      this.phase = 'gone';
      this.goneLeft = TALK.LINE_SEC * 1.5; // 別れのあいさつはしばらく出しておく
      this.queue = [];
      out.left = true;
      out.togetherM = segM - this.togetherFromM;
      out.say = this.text = this.companion.farewell.join('');
      return out;
    }
    if (!moving) return out; // 止まっている間は道連れも待っている(話は進めない)

    // 話せるペースか(行ったり来たりでちらつかないよう、続いた秒数で切り替える)
    if (powerW > ceilingW) { this.hardSec += dtSec; this.easySec = 0; } else { this.easySec += dtSec; this.hardSec = 0; }
    if (this.pace === 'easy' && this.hardSec >= TALK.HARD_AFTER_SEC) {
      this.pace = 'hard';
      out.say = this.text = this.companion.slowDown;
      return out;
    }
    if (this.pace === 'hard') {
      if (this.easySec < TALK.RESUME_AFTER_SEC) return out;
      this.pace = 'easy';
      this.lineLeft = TALK.LINE_SEC;
      out.say = this.text = this.companion.resume;
      return out;
    }

    // 天気の変化・トンネルは、今の話題が終わったら次に話す
    if (weatherKind && weatherKind !== this.lastWeather) {
      this.lastWeather = weatherKind;
      if (WEATHER_TOPICS[weatherKind]) this.agenda.unshift(WEATHER_TOPICS[weatherKind]);
    }
    if (inTunnel && !this.toldTunnel) {
      this.toldTunnel = true;
      this.agenda.unshift(TUNNEL_TOPIC);
      this.gapLeft = Math.min(this.gapLeft, 1);
    }

    if (this.lineLeft > 0) {
      this.lineLeft -= dtSec;
      if (this.lineLeft > 0) return out;
      if (this.queue.length) return this._sayNext(out);
      this.text = null;
      this.gapLeft = TALK.GAP_SEC;
      if (this._chapterJustTold !== undefined) {
        out.chapterDone = this._chapterJustTold;
        this._chapterJustTold = undefined;
      }
      return out;
    }
    // 話題のあいだ: 近くの地点の話があれば間を縮めて先に話す
    const place = places.find((p) => PLACE_TOPICS[p.id] && !this.toldPlaces.has(p.id)
      && p.atM >= segM && p.atM - segM <= TALK.PLACE_AHEAD_M);
    if (place) {
      this.toldPlaces.add(place.id);
      this._startTopic(PLACE_TOPICS[place.id]);
      return this._sayNext(out);
    }
    this.gapLeft -= dtSec;
    if (this.gapLeft > 0) return out;
    const next = this.agenda.shift();
    if (!next) { this.gapLeft = TALK.GAP_SEC; return out; } // 話が尽きたら、黙って並走
    if (next.story !== undefined) {
      this._chapterJustTold = next.story;
      this.chapter = next.story + 1;
      this._startTopic(this.companion.chapters[next.story]);
    } else {
      this._startTopic(next);
    }
    return this._sayNext(out);
  }

  /** 画面表示用: 今の状態。 */
  view() {
    if (this.phase === 'gone') return this.goneLeft > 0
      ? { name: this.companion.name, who: this.companion.who, text: this.text, pace: 'easy', gone: true } : null;
    if (this.phase !== 'together') return null;
    return { name: this.companion.name, who: this.companion.who, text: this.text, pace: this.pace };
  }

  _startTopic(lines) {
    this.queue = [...lines];
  }

  _sayNext(out) {
    out.say = this.text = this.queue.shift();
    this.lineLeft = TALK.LINE_SEC;
    return out;
  }
}

/**
 * 道連れと会ったことを旅に残す(身の上話がどこまで進んだか)。旅の形式は変えず、trip.companions を足すだけ。
 * @param {object} trip
 * @param {string} id 道連れの id
 * @param {number} chapter 次に話す章(話し終えた章 + 1)
 */
export function recordCompanion(trip, id, chapter) {
  const prev = trip.companions?.[id] ?? { chapter: 0, met: 0 };
  return {
    ...trip,
    companions: { ...(trip.companions ?? {}), [id]: { chapter: Math.max(prev.chapter, chapter), met: prev.met } },
  };
}

/** 並走を終えたとき: 会った回数を数える。 */
export function recordCompanionMet(trip, id) {
  const prev = trip.companions?.[id] ?? { chapter: 0, met: 0 };
  return { ...trip, companions: { ...(trip.companions ?? {}), [id]: { ...prev, met: prev.met + 1 } } };
}

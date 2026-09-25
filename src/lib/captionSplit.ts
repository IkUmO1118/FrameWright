// lib/captionSplit.ts — whisper セグメント(transcript.json の 1 発話 = 1 テロップ)を
// 「読みやすい 1 枚」の粒度へ割り直す純関数(fs 非依存・決定論・LLM 不使用)。
//
// 現状の transcribe は whisper の transcription セグメントを 1:1 でテロップにするため、
// 粒度は whisper 内部のチャンク幅そのまま(長い区間は 40〜50 字にもなる)。ここは
// それを「意味の切れ目で折った 1 枚」へ割り直す。
//
// ## アルゴリズム(2026-08-04 改訂)
//
// 旧実装は「文字数上限に収まる範囲で見つかった **最後の** 文節末で折る」貪欲法
// だった。日本語は助詞がほぼ毎文節に出るため候補が乱立し、「。」も「を」も同格に
// 扱ってしまう。結果として上限よりかなり手前の弱い助詞で切れ、テロップが不自然に
// 短く刻まれていた。
//
// 新実装は 2 つの層でこれを解く:
//
// 1. **区切りの強さ(breakStrength)**: 各境界に 0..1 のスコアを与える。
//    句点 > 述語の終止形(です/ます) > 接続助詞(から/ので/けど) > 格助詞(は/を/に)
//    > 連体の「の」という階層があり、さらに「無音の間」(words[] があるときだけ)を
//    確率的 OR で合成する。次の語が前へ密着する助詞なら強く減点、文頭に来る接続詞
//    (でも/しかし/つまり)なら加点、括弧の内側・英数字/カタカナ語の途中は禁止に近い。
//
// 2. **全体最適の分割(Knuth-Plass 型 DP)**: 貪欲に前から折るのではなく、
//    「区切りの弱さ」+「目標文字数からの乖離」+「短すぎる断片」+「短すぎる表示秒」
//    の総和を最小化する分割を動的計画法で選ぶ。局所的に美味しい弱い区切りに
//    飛びつかず、少し我慢して次の強い区切りまで伸ばす、という判断ができる。
//
// 語タイムスタンプ(words[])があれば分割後の各断片の start/end は語境界そのもの
// (時刻を捏造しない)。無ければ文字位置で線形補間する。maxChars 以下のセグメントは
// 一切改変しない(text/start/end/words/id をそのまま返す=導入前とバイト等価)。
//
// ## 空白で語を区切る言語(英語など。2026-09-24 追加)
//
// 上の語彙はすべて日本語なので、英語の segment に同じ規則を当てると区切りの手がかりが
// 無く、ほぼ字数だけで空白に落ちて文の途中で刻まれていた。さらに whisper の英語
// トークンは語頭に空白を持ち、buildWords が trim するため words[] の連結が text と
// 一致せず、1 文字 atom(時刻は線形補間・words[] 喪失)へ落ちていた。
// ラテン文字が主体で空白を含む segment は「空白区切りモード」として扱い、
//   - words[] は text 上の空白を読み飛ばして位置合わせする(語 atom を保つ)
//   - 字数上限は maxCharsLatin / minCharsLatin(英語は 1 字が細いので日本語より長い)
//   - 区切りは語境界(空白)だけで、句読点 > 節の頭(and/but/because…) > 前置詞の前、
//     冠詞・所有格・to などの直後は切らない
//   - 断片の前後の空白は落とす
// を適用する。日本語の segment の挙動は変わらない。

import { round2 } from "./candidates.ts";
import type { TranscriptSegment, WordTiming } from "../types.ts";

export interface CaptionSplitCfg {
  /** この文字数(code point 数)を超える segment だけを分割する。分割後の各断片も
   *  この長さを超えない(単一の語がこれより長い病的ケースだけ例外)。
   *  0 以下 / 未設定なら分割しない(呼び出し側で opt-in を判定) */
  maxChars: number;
  /** 分割後の断片がこれ未満だと強い減点を受ける(ハード禁止ではない=どう割っても
   *  短くなる入力でも必ず解が出る)。省略時 floor(maxChars * 0.4) */
  minChars?: number;
  /** 語間ギャップ(秒)がこれ未満なら「間」として数えない(微小な無音の無視)。
   *  省略時 0.3(plan の minSplitGapSec と同じ既定)。words[] がある segment にだけ効く */
  gapSec?: number;
  /** この秒数の語間ギャップで「間」の強さが最大(1.0)になる。省略時 0.8。
   *  gapSec 〜 pauseFullSec の間は線形に効く。words[] がある segment にだけ効く */
  pauseFullSec?: number;
  /** 各断片の表示秒がこれ未満だと減点する(一瞬だけ光って消えるテロップの抑制)。
   *  省略時 0.9 秒。0 以下で無効 */
  minDurationSec?: number;
  /** 空白区切りの segment(英語など)の maxChars。英字は和文より細いので長めに取る。
   *  省略時 round(maxChars * 1.6) */
  maxCharsLatin?: number;
  /** 空白区切りの segment の minChars。省略時 floor(maxCharsLatin * 0.4) */
  minCharsLatin?: number;
}

type ResolvedCfg = Required<CaptionSplitCfg>;

/* ------------------------------------------------------------------ *
 * コスト重み(内部定数)
 * ------------------------------------------------------------------ */

/** 区切りの弱さの重み。これを上げると「強い区切りで折る」を優先し、断片長は不揃いになる。
 *  長さの重み(W_LEN)より十分大きく取る: 「1 枚増やしてでも語の途中で切らない」を
 *  成立させるには、最悪の区切り 1 箇所のコストが断片 1 枚ぶんの長さコストを上回る
 *  必要がある */
const W_BREAK = 4.0;
/** maxChars からの不足の重み。これを上げると「上限まで詰める/長さを揃える」を優先する。
 *  2 乗なので、断片が短いほど急激に高くつく=「弱い区切りで早々に折る」を抑える */
const W_LEN = 1.0;
/** minChars 未満の重み。断片が短くなりすぎるのを強く嫌う */
const W_MIN = 6.0;
/** minDurationSec 未満の重み(表示が一瞬になるのを嫌う) */
const W_DUR = 3.0;

/** 何の手がかりも無い位置(語の途中)の区切りの強さ */
const BASE_STRENGTH = 0.06;

/* ------------------------------------------------------------------ *
 * 区切りの強さの語彙
 * ------------------------------------------------------------------ */

/**
 * 断片の末尾がこの文字列で終わるときの区切りの強さ(0..1)。**最長一致**で 1 件だけ
 * 採用する(「ました」は「た」より、「ですね」は「です」より優先)。
 *
 * 階層の根拠: 日本語字幕の改行は「文 > 節 > 文節」の順に自然。whisper の日本語出力は
 * 句読点をほとんど出さないため、実質の文末判定は述語の終止形が担う。逆に格助詞は
 * ほぼ全文節に現れるので、ここを句点と同格に扱うと刻みすぎになる(旧実装の不具合)。
 */
const BREAK_SUFFIXES: ReadonlyArray<readonly [string, number]> = [
  // 句点 = 文の終わり(最強)
  ["。", 0.98], ["！", 0.98], ["？", 0.98], ["!", 0.98], ["?", 0.98], ["．", 0.98],
  // 読点 = 節の切れ目(書き手が明示した区切り)
  ["、", 0.85], ["，", 0.85], [",", 0.85],
  // 述語の終止形 = 実質の文末(whisper が句点を出さないぶんここが要)
  ["ましょう", 0.84], ["でしょう", 0.84], ["ました", 0.84], ["ません", 0.84], ["でした", 0.84],
  ["ください", 0.82], ["ですね", 0.80], ["ですよ", 0.80], ["ますね", 0.80], ["ますよ", 0.80],
  ["です", 0.78], ["ます", 0.78], ["である", 0.76], ["だった", 0.72],
  ["ない", 0.58], ["だ", 0.52],
  // 接続助詞 = 節の切れ目
  ["けれども", 0.70], ["けれど", 0.70], ["けど", 0.70], ["のに", 0.66], ["ので", 0.66],
  ["から", 0.62], ["ながら", 0.60], ["たら", 0.60], ["なら", 0.60], ["ても", 0.60],
  ["って", 0.60], ["たり", 0.58], ["ば", 0.55], ["し", 0.55],
  // 前後どちらの用法か決められない助詞(接続助詞なら強い・格助詞なら弱いの中間)
  ["が", 0.45], ["て", 0.45], ["で", 0.40],
  // 格助詞・係助詞・終助詞 = 文節の切れ目(弱い)
  ["ね", 0.35], ["よ", 0.35], ["は", 0.32], ["も", 0.32], ["を", 0.30],
  ["に", 0.30], ["へ", 0.30], ["か", 0.30], ["わ", 0.30], ["と", 0.28], ["や", 0.28],
  ["な", 0.25], ["さ", 0.20],
  // 連体修飾の「の」は次の語へ強く結びつく(「私の|本」は切ってはいけない)
  ["の", 0.12],
];

/** 文の終わり(ここで折るのは常に自然)。この直後は行頭禁則の減点を免除する。 */
const HARD_SENTENCE_END: ReadonlySet<string> = new Set(["。", "！", "？", "!", "?", "．"]);

/** 最長一致にするため長い順に並べた表(module load 時に 1 回だけ) */
const BREAK_SUFFIXES_SORTED: ReadonlyArray<readonly [string, number]> =
  [...BREAK_SUFFIXES].sort((a, b) => b[0].length - a[0].length);

/**
 * 次の断片が **これで始まる** なら、そこは語の途中(活用・機能語の続き)なので
 * 切ってはいけない。**前方一致**で判定するので words[] の有無に関わらず効き、
 * 1 文字ずつの atom でも「動かなくてし|かも」「と|いう」を防げる。
 *
 * 直前の接尾判定(BREAK_SUFFIXES)は「後ろから」しか見ないため、"しかも" の "し" を
 * 接続助詞の "し" と誤認する。この表はその誤認を前方から打ち消す役目を持つ。
 */
const NO_LINE_START_PREFIXES: readonly string[] = [
  // 接続助詞・引用(前の節へ密着する)
  "けれども", "けれど", "けど", "ので", "のに", "から", "ながら", "たら", "なら",
  "ても", "たり", "って", "という", "といった", "とか",
  // 助詞・接尾(前の名詞へ密着する)
  "など", "まで", "より", "だけ", "しか", "ほど", "ばかり", "なんて", "かも",
  "ような", "ように", "ため",
  // 述語の活用の続き
  "ですが", "ですね", "ですよ", "でした", "です", "ました", "ません", "ます",
  "だった", "ください", "ている", "ていく", "てくる", "ておく", "しまう", "ちゃう",
].sort((a, b) => b.length - a.length);

/**
 * 次の断片の先頭に来ると「そこで切ってはいけない」語(前の語へ密着する助詞・接尾)。
 * こちらは語 **全体** の一致で見るため words[] があるときだけ効く
 * (1 文字 atom では「な」「の」等が偶然一致してしまうため)。
 */
const ATTACHING_NEXT: ReadonlySet<string> = new Set([
  "は", "が", "を", "に", "へ", "と", "も", "の", "で", "や", "か", "ね", "よ", "な", "さ",
  "って", "という", "といった", "との", "への", "からの", "における",
  "まで", "より", "だけ", "こそ", "しか", "ほど", "ばかり", "など", "なんて",
  "です", "ます", "でした", "ました", "ません", "だった", "ください",
]);

/**
 * 次の断片の先頭に来ると「そこで切るのが自然」な語(文頭に立つ接続詞・談話標識)。
 * words[] があるときだけ効く。
 */
const CONJUNCTION_NEXT: ReadonlySet<string> = new Set([
  "でも", "しかし", "だから", "ですから", "そして", "それで", "それから", "それに",
  "ただ", "ただし", "また", "つまり", "なので", "だが", "ところが", "とはいえ",
  "例えば", "たとえば", "もちろん", "実は", "じつは", "要するに", "結局", "一方",
  "逆に", "さらに", "そこで", "ちなみに", "まず", "次に", "最後に", "そのため", "その結果",
]);

/* ------------------------------------------------------------------ *
 * 空白区切りモード(英語)の語彙
 * ------------------------------------------------------------------ */

/** 空白区切りの語境界(手がかりなし)の区切りの強さ。和文の文節末(格助詞)相当 */
const LATIN_WORD_BREAK = 0.3;

/** 次の語がこれなら節の頭=そこで折るのが自然(等位・従属接続詞・関係詞) */
const LATIN_CLAUSE_START: ReadonlySet<string> = new Set([
  "and", "but", "or", "so", "because", "which", "who", "whom", "whose", "where", "when",
  "while", "if", "unless", "until", "although", "though", "since", "whereas", "then",
  "yet", "however", "therefore", "otherwise",
]);

/** 次の語がこれなら句の頭(前置詞・不定詞の to)=弱めに折ってよい */
const LATIN_PHRASE_START: ReadonlySet<string> = new Set([
  "to", "in", "on", "at", "for", "with", "from", "of", "by", "about", "into", "onto",
  "over", "under", "through", "after", "before", "during", "without", "within", "like",
  "than", "as", "against", "between", "toward", "towards",
]);

/** 直前の語がこれなら次の語と強く結びつく(冠詞・所有格・前置詞など)=折らない */
const LATIN_BINDING_PREV: ReadonlySet<string> = new Set([
  "a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "this", "these",
  "those", "to", "of", "in", "on", "at", "for", "with", "from", "by", "into", "very",
  "not", "no", "every", "each", "some", "any", "more", "most", "such", "i", "you're",
  "i'm", "we're", "they're", "it's", "don't", "can't", "won't", "didn't", "doesn't",
]);

/** ピリオドで終わっても文末ではない略語(小文字化・ピリオド抜きで照合) */
const LATIN_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "eg", "ie", "vol",
  "fig", "approx", "inc", "ltd", "co", "corp",
]);

const firstLatinWord = (s: string): string =>
  (/^[A-Za-z0-9'’]+/.exec(s.trimStart())?.[0] ?? "").toLowerCase().replace(/’/g, "'");
const lastLatinWord = (s: string): string =>
  (/[A-Za-z0-9'’]+$/.exec(s)?.[0] ?? "").toLowerCase().replace(/’/g, "'");
const isWs = (ch: string): boolean => /\s/.test(ch);

/**
 * segment が空白区切りの言語(英語など)か。ラテン文字が和文字(かな・漢字)より
 * 多く、かつ空白を含むとき true。日本語文中の "Claude Code" 程度では false のまま
 * (従来どおり和文の規則で割る)。
 */
export function isSpaceDelimited(text: string): boolean {
  let latin = 0;
  let cjk = 0;
  let ws = false;
  for (const ch of text) {
    const sc = scriptOf(ch);
    if (sc === "latin") latin++;
    else if (sc === "hiragana" || sc === "katakana" || sc === "kanji") cjk++;
    else if (isWs(ch)) ws = true;
  }
  return ws && latin > cjk;
}

/** 次の断片の先頭に来てはいけない文字。ここでの分割は禁止(いわゆる行頭禁則)。
 *  句読点・閉じ括弧に加えて、小書き仮名・長音符・撥音は語頭に立てないので必ず含める
 *  (これが無いと「プロジェクトフ|ォルダ」のような分割が起きる) */
const NO_START_CHARS: ReadonlySet<string> = new Set([
  "。", "、", "！", "？", "!", "?", ",", ".", "．", "，", "：", "；", ":", ";",
  "」", "』", ")", "）", "]", "］", "}", "｝", "〉", "》", "”", "’",
  "ー", "〜", "～", "…", "‥", "・", "々", "ゝ", "ヽ",
  // 小書き仮名・促音・撥音(語頭に立たない)
  "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ", "ゎ", "ん",
  "ァ", "ィ", "ゥ", "ェ", "ォ", "ッ", "ャ", "ュ", "ョ", "ヮ", "ヵ", "ヶ", "ン",
]);

/** 直前の断片の末尾に来てはいけない文字(開き括弧)。ここでの分割は禁止 */
const NO_END_CHARS: ReadonlySet<string> = new Set([
  "「", "『", "(", "（", "[", "［", "{", "｛", "〈", "《", "“", "‘",
]);

const OPEN_BRACKETS: ReadonlySet<string> = new Set(["「", "『", "(", "（", "[", "［", "{", "｛", "〈", "《"]);
const CLOSE_BRACKETS: ReadonlySet<string> = new Set(["」", "』", ")", "）", "]", "］", "}", "｝", "〉", "》"]);

/* ------------------------------------------------------------------ *
 * 文字種(語の途中で切らないための近似)
 * ------------------------------------------------------------------ */

type Script = "latin" | "digit" | "katakana" | "hiragana" | "kanji" | "other";

function scriptOf(ch: string): Script {
  const c = ch.codePointAt(0) ?? 0;
  if ((c >= 0x30 && c <= 0x39) || (c >= 0xff10 && c <= 0xff19)) return "digit";
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return "latin";
  if (c >= 0x30a1 && c <= 0x30fa) return "katakana";
  if (c >= 0x3041 && c <= 0x309f) return "hiragana";
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) return "kanji";
  return "other";
}

/** 文字数は code point 数で数える([...s].length)。日本語 1 字も ASCII 1 字も 1。
 *  2026-07-12 の手編集粒度("Claude Code" を 11 字と数える)と同じ規約 */
const clen = (s: string): number => [...s].length;

const lastCharOf = (s: string): string => {
  const a = [...s];
  return a.length > 0 ? a[a.length - 1] : "";
};
const firstCharOf = (s: string): string => [...s][0] ?? "";

/**
 * 断片の末尾テキストから、言語的な区切りの強さ(0..1)を引く純関数。
 * BREAK_SUFFIXES の最長一致 1 件だけを採用し、無ければ BASE_STRENGTH。
 */
export function suffixBreakStrength(text: string): number {
  for (const [suffix, strength] of BREAK_SUFFIXES_SORTED) {
    if (text.endsWith(suffix)) return strength;
  }
  return BASE_STRENGTH;
}

/** 「間」(語間ギャップ)の強さ。gapSec 未満は 0、pauseFullSec 以上は 1、間は線形 */
export function pauseBreakStrength(gapSec: number, cfg: { gapSec: number; pauseFullSec: number }): number {
  if (!Number.isFinite(gapSec) || gapSec < cfg.gapSec) return 0;
  const span = Math.max(cfg.pauseFullSec - cfg.gapSec, 1e-6);
  return Math.min(1, (gapSec - cfg.gapSec) / span);
}

/* ------------------------------------------------------------------ *
 * Atom(分割の最小単位)
 * ------------------------------------------------------------------ */

/** 分割計算に使う最小単位。words[] があればそれ、無ければ 1 文字ずつ(時刻は線形補間) */
interface Atom {
  text: string;
  start: number;
  end: number;
  /** この atom が元の words[] 由来か(true のとき出力 segment に words を残せる) */
  word?: WordTiming;
}

/** segment を Atom 列へ。words[] が text を過不足なく覆うならそれを使い(時刻正確)、
 *  そうでなければ 1 文字ずつに割って [start,end] を文字数で線形補間する。 */
function atomsOf(seg: TranscriptSegment): Atom[] {
  const words = seg.words;
  if (words && words.length > 0 && words.map((w) => w.text).join("") === seg.text) {
    return words.map((w) => ({ text: w.text, start: w.start, end: w.end, word: w }));
  }
  const aligned = words && words.length > 0 ? alignWordsSkippingSpaces(seg.text, words) : null;
  if (aligned) return aligned;
  const chars = [...seg.text];
  const total = chars.length;
  const dur = seg.end - seg.start;
  return chars.map((ch, i) => ({
    text: ch,
    start: round2(seg.start + (dur * i) / total),
    end: round2(seg.start + (dur * (i + 1)) / total),
  }));
}

/**
 * words[] を text 上へ、語間の空白を読み飛ばして位置合わせする。whisper の英語
 * トークンは語頭に空白を持ち、buildWords が trim するため連結が text と一致しない。
 * ここでは空白を直後の語 atom の先頭へ付けて text を過不足なく覆う(atom の連結 ===
 * text)。空白以外の食い違いが 1 つでもあれば null(文字 atom へフォールバック)。
 */
function alignWordsSkippingSpaces(text: string, words: WordTiming[]): Atom[] | null {
  const atoms: Atom[] = [];
  let pos = 0;
  for (const w of words) {
    const start = pos;
    while (pos < text.length && isWs(text[pos])) pos++;
    if (w.text.length === 0 || !text.startsWith(w.text, pos)) return null;
    pos += w.text.length;
    atoms.push({ text: text.slice(start, pos), start: w.start, end: w.end, word: w });
  }
  if (pos < text.length) {
    if (text.slice(pos).trim() !== "" || atoms.length === 0) return null;
    atoms[atoms.length - 1].text += text.slice(pos);
  }
  return atoms;
}

/**
 * 文末記号の直後に空白なしで次の文が続く境界か(whisper は英語で "succeed.I want" の
 * ように文間の空白を落とすことがある)。次が大文字で始まり、直前の語が 2 字以上の
 * ときだけ true("U.S." や "3.5" は対象外)。
 */
function isGluedSentenceEnd(tail: string, nextCh: string): boolean {
  if (!/[.!?]$/.test(tail) || !/[A-Z]/.test(nextCh)) return false;
  return lastLatinWord(tail.slice(0, -1)).length >= 2;
}

/** 空白区切りモードの語境界(atom i の直後、next が空白で始まる)の区切りの強さ */
function latinBoundaryStrength(tail: string, ahead: string): number {
  const endCh = lastCharOf(tail);
  let s = Math.max(suffixBreakStrength(tail), LATIN_WORD_BREAK);
  // 空白の直前のピリオド = 文末(句点相当)。BREAK_SUFFIXES に "." を入れないのは
  // "3.5" や "U.S." を誤認しないため。ここは空白の直前だけなので "3.5" は来ず、
  // 1 字語("U.S." の "S")と敬称などの略語は除く(isGluedSentenceEnd と同じ規則)
  if (endCh === ".") {
    const prev = lastLatinWord(tail.slice(0, -1));
    if (prev.length >= 2 && !LATIN_ABBREVIATIONS.has(prev)) s = Math.max(s, 0.98);
  }
  if (endCh === ";") s = Math.max(s, 0.8);
  else if (endCh === ":") s = Math.max(s, 0.75);
  const next = firstLatinWord(ahead);
  if (LATIN_CLAUSE_START.has(next)) s = Math.max(s, 0.68);
  else if (LATIN_PHRASE_START.has(next)) s = Math.max(s, 0.45);
  // 直前の語が次へ強く結びつく(句読点で終わっていれば lastLatinWord は空=対象外)
  if (LATIN_BINDING_PREV.has(lastLatinWord(tail))) s = Math.min(s, 0.05);
  return s;
}

/**
 * 「atom i の直後で折る」ときの区切りの強さ(0..1)を全境界ぶん前計算する。
 * 最後の境界(= segment の終端)は常に 1(そこは元から切れ目)。
 *
 * wordAtoms=false(1 文字ずつの atom)のときは、次の語による加減点
 * (ATTACHING_NEXT / CONJUNCTION_NEXT)を行わない。1 文字では「な」「の」等が
 * 助詞かどうか判別できず、誤検出のほうが害が大きいため。
 */
function boundaryStrengths(
  atoms: Atom[],
  cfg: ResolvedCfg,
  wordAtoms: boolean,
  spaced: boolean,
): number[] {
  const n = atoms.length;
  const out = new Array<number>(n).fill(0);
  // 括弧の深さ(atom i までを読み終えた時点)。括弧の内側では折らない
  let depth = 0;

  // 累積テキスト(最長一致の接尾判定に使う)。最長の接尾辞ぶんだけ持てば十分
  // 空白区切りモードは直前の語全体(lastLatinWord)を見るので長めに持つ
  const maxSuffixLen = Math.max(BREAK_SUFFIXES_SORTED[0][0].length, spaced ? 32 : 0);
  let tail = "";

  // 境界 i の「次に来る文字列」(前方一致判定用)。最長の禁止接頭辞ぶんだけあれば十分
  // 空白区切りモードは次の語全体(firstLatinWord)を見るので長めに持つ
  const maxPrefixLen = Math.max(NO_LINE_START_PREFIXES[0]?.length ?? 0, spaced ? 32 : 0);
  const aheadTexts = new Array<string>(n).fill("");
  {
    let ahead = "";
    for (let i = n - 1; i >= 0; i--) {
      ahead = (atoms[i].text + ahead).slice(0, maxPrefixLen);
      if (i > 0) aheadTexts[i - 1] = ahead;
    }
  }

  for (let i = 0; i < n; i++) {
    const cur = atoms[i];
    for (const ch of cur.text) {
      if (OPEN_BRACKETS.has(ch)) depth++;
      else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
    }
    tail = (tail + cur.text).slice(-maxSuffixLen);

    if (i === n - 1) {
      out[i] = 1; // segment の終端は常に切れ目
      break;
    }
    const next = atoms[i + 1];

    // --- 禁止条件(ここで折ってはいけない) ---
    const endCh = lastCharOf(cur.text);
    const startCh = firstCharOf(next.text);
    if (NO_START_CHARS.has(startCh) || NO_END_CHARS.has(endCh) || depth > 0) {
      out[i] = 0;
      continue;
    }

    // --- 空白区切りモード(英語): 語境界(空白の直前)だけで折る ---
    if (spaced) {
      let s: number;
      if (isWs(startCh)) s = latinBoundaryStrength(tail, aheadTexts[i]);
      else if (isGluedSentenceEnd(tail, startCh)) s = 0.98; // whisper の "succeed.I want"
      else s = isWs(endCh) ? 0 : 0.02; // 空白の直後・語の途中("Isn|'t")では折らない
      const pause = pauseBreakStrength(next.start - cur.end, cfg);
      if (s > 0 && pause > 0) s = 1 - (1 - s) * (1 - pause * 0.9);
      out[i] = Math.max(0, Math.min(1, s));
      continue;
    }

    // --- 言語的な強さ ---
    let s = suffixBreakStrength(tail);

    // 次が語の途中(活用・機能語の続き)なら、後ろから見た接尾判定は誤認なので打ち消す。
    // 前方一致なので atom が 1 文字でも効く(「動かなくてし|かも」を防ぐ)
    const ahead = aheadTexts[i];
    // 句点の直後は「文の終わり」が確定しているので、次語の接頭による減点は掛けない。
    if (!HARD_SENTENCE_END.has(endCh) && NO_LINE_START_PREFIXES.some((p) => ahead.startsWith(p))) {
      s *= 0.12;
    }

    if (wordAtoms) {
      if (ATTACHING_NEXT.has(next.text)) s *= 0.1; // 次が前へ密着する助詞 → 切らない
      if (CONJUNCTION_NEXT.has(next.text)) s = Math.max(s, 0.75); // 次が接続詞 → 切るのが自然
    }

    // --- 語の途中(同じ文字種の連なり)では切らない ---
    const a = scriptOf(endCh);
    const b = scriptOf(startCh);
    if ((a === "latin" || a === "digit") && (b === "latin" || b === "digit")) s = Math.min(s, 0.02);
    else if (a === "katakana" && b === "katakana") s = Math.min(s, 0.08);
    else if (a === "kanji" && b === "kanji") s = Math.min(s, 0.20);
    else if (a === "hiragana" && b === "hiragana" && s < 0.6) {
      // ひらがなが続く境界は語の途中である公算が高い(「持って|いかれてる」)。
      // ただし強い接尾(句点・述語の終止形・主要な接続助詞)はこの推定に優先する
      s = Math.min(s, 0.10);
    }

    // --- 「間」との合成(確率的 OR。弱い助詞 + 実際の無音 = 強い切れ目) ---
    const gap = next.start - cur.end;
    const pause = pauseBreakStrength(gap, cfg);
    if (pause > 0) s = 1 - (1 - s) * (1 - pause * 0.9);

    out[i] = Math.max(0, Math.min(1, s));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 分割の探索(Knuth-Plass 型 DP)
 * ------------------------------------------------------------------ */

/**
 * Atom 列を「断片(atom index の [a,b] 範囲・inclusive)」の列へ分割する。
 *
 * 貪欲ではなく **全体のコスト最小** を動的計画法で選ぶ。コストは
 *   (1) 区切りの弱さ  (1 - strength)^2 * W_BREAK
 *   (2) maxChars からの不足                     * W_LEN
 *   (3) minChars 未満の不足                     * W_MIN
 *   (4) minDurationSec 未満の表示秒の不足        * W_DUR
 * の総和。maxChars はハード上限(唯一の例外: 1 atom 単体がそれを超える病的ケース。
 * このときだけその atom 単独を 1 断片として通し、必ず前進することを保証する)。
 */
function pieceRanges(
  atoms: Atom[],
  cfg: ResolvedCfg,
  wordAtoms: boolean,
  spaced: boolean,
): Array<[number, number]> {
  const n = atoms.length;
  if (n === 0) return [];

  const cum = [0];
  for (const a of atoms) cum.push(cum[cum.length - 1] + clen(a.text));
  // 断片の先頭 atom が持つ空白は出力で落とすので字数に数えない(和文は常に 0)
  const leadWs = atoms.map((a) => clen(a.text) - clen(a.text.trimStart()));
  const strength = boundaryStrengths(atoms, cfg, wordAtoms, spaced);

  /** 断片 atoms[i..j](inclusive)のコスト */
  const pieceCost = (i: number, j: number, len: number): number => {
    let cost = (1 - strength[j]) ** 2 * W_BREAK;

    if (len < cfg.maxChars) {
      cost += ((cfg.maxChars - len) / cfg.maxChars) ** 2 * W_LEN;
    }

    if (cfg.minChars > 0 && len < cfg.minChars) {
      cost += ((cfg.minChars - len) / cfg.minChars) ** 2 * W_MIN;
    }

    if (cfg.minDurationSec > 0) {
      const dur = atoms[j].end - atoms[i].start;
      if (dur < cfg.minDurationSec) {
        cost += ((cfg.minDurationSec - dur) / cfg.minDurationSec) ** 2 * W_DUR;
      }
    }
    return cost;
  };

  // best[j] = atoms[0..j-1] を分割し終えたときの最小コスト
  const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Array<number>(n + 1).fill(-1);
  best[0] = 0;

  for (let j = 1; j <= n; j++) {
    // i を大きい順(= 断片が短い順)に見る。maxChars を超えたら以降は伸びるだけなので打ち切る。
    // 最初の候補 i = j-1(単一 atom)は常に許可するので、解は必ず存在する。
    for (let i = j - 1; i >= 0; i--) {
      const len = cum[j] - cum[i] - leadWs[i];
      if (len > cfg.maxChars && i < j - 1) break;
      if (best[i] === Number.POSITIVE_INFINITY) continue;
      const c = best[i] + pieceCost(i, j - 1, len);
      // 同点なら i が小さいほう(= 断片が長いほう)を採る決定論的タイブレーク
      if (c <= best[j]) {
        best[j] = c;
        from[j] = i;
      }
    }
  }

  const ranges: Array<[number, number]> = [];
  for (let j = n; j > 0; j = from[j]) ranges.push([from[j], j - 1]);
  ranges.reverse();
  return ranges;
}

/* ------------------------------------------------------------------ *
 * segment への適用
 * ------------------------------------------------------------------ */

/** 1 つの segment を分割し、分割後の segment 列を返す。maxChars 以下、または分割の
 *  必要が無ければ元 segment を **そのまま**(同一参照)返す=非改変を保証。 */
function splitOne(seg: TranscriptSegment, baseCfg: ResolvedCfg): TranscriptSegment[] {
  const spaced = isSpaceDelimited(seg.text);
  const cfg = spaced
    ? { ...baseCfg, maxChars: baseCfg.maxCharsLatin, minChars: baseCfg.minCharsLatin }
    : baseCfg;
  if (clen(seg.text) <= cfg.maxChars) return [seg];
  const atoms = atomsOf(seg);
  const wordAtoms = atoms.length > 0 && atoms[0].word !== undefined;
  const ranges = pieceRanges(atoms, cfg, wordAtoms, spaced);
  if (ranges.length <= 1) return [seg]; // 割れなかった(単一ピース)=非改変
  return ranges.map(([a, b]) => {
    const slice = atoms.slice(a, b + 1);
    const piece: TranscriptSegment = {
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      // 断片の前後の空白は落とす(空白区切りモードで語境界に残る。和文は無変化)
      text: slice.map((x) => x.text).join("").trim(),
    };
    // track/pos/style は元 segment 属性を全ピースへ継承(whisper 直後は通常未設定)
    if (seg.track !== undefined) piece.track = seg.track;
    if (seg.pos !== undefined) piece.pos = seg.pos;
    if (seg.style !== undefined) piece.style = seg.style;
    // words[] は語 atom のときだけ残せる(カラオケ表示の維持)
    const words = slice.map((x) => x.word).filter((w): w is WordTiming => w !== undefined);
    if (words.length === slice.length && words.length > 0) piece.words = words;
    // id は付けない(分割後は新しい要素。呼び出し側の id 採番に委ねる)
    return piece;
  });
}

/** cfg の省略値を埋める(既定値の単一の出所) */
export function resolveCaptionSplitCfg(cfg: CaptionSplitCfg): ResolvedCfg {
  const maxChars = cfg.maxChars;
  const maxCharsLatin = cfg.maxCharsLatin ?? Math.round(maxChars * 1.6);
  return {
    maxChars,
    minChars: cfg.minChars ?? Math.floor(maxChars * 0.4),
    gapSec: cfg.gapSec ?? 0.3,
    pauseFullSec: cfg.pauseFullSec ?? 0.8,
    minDurationSec: cfg.minDurationSec ?? 0.9,
    maxCharsLatin,
    minCharsLatin: cfg.minCharsLatin ?? Math.floor(maxCharsLatin * 0.4),
  };
}

/**
 * transcript の segments を読みやすい粒度へ割り直す。
 * cfg.maxChars <= 0 なら何もせず入力をそのまま返す(opt-in・バイト等価)。
 * 各 segment は独立に分割され、時系列順・件数増加のみ(並べ替えはしない)。
 */
export function splitLongCaptions(
  segments: TranscriptSegment[],
  cfg: CaptionSplitCfg,
): TranscriptSegment[] {
  if (!cfg || cfg.maxChars <= 0) return segments;
  const resolved = resolveCaptionSplitCfg(cfg);
  const out: TranscriptSegment[] = [];
  for (const seg of segments) out.push(...splitOne(seg, resolved));
  return out;
}

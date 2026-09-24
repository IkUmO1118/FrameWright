// lib/captionSplit.ts のテロップ粒度割り直し。whisper の長い 1 セグメントを
// 「約 maxChars 文字」の文節境界で割り、時刻(words[] があれば語境界)・文言・
// カラオケ補助データ(words[])の整合を保つことを固定する純関数テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSpaceDelimited,
  pauseBreakStrength,
  resolveCaptionSplitCfg,
  splitLongCaptions,
  suffixBreakStrength,
} from "../src/lib/captionSplit.ts";
import type { TranscriptSegment, WordTiming } from "../src/types.ts";

// 実データ(2026-07-12 の whisper 生セグメント)を模した 30 字・語タイムスタンプ付き。
// 手編集では「時間もお金も両方持っていかれてるって|結構理不尽じゃないですか」に割れた。
const words30: WordTiming[] = [
  { text: "時間", start: 13.36, end: 13.76 },
  { text: "も", start: 13.76, end: 13.96 },
  { text: "お金", start: 13.96, end: 14.36 },
  { text: "も", start: 14.36, end: 14.56 },
  { text: "両方", start: 14.56, end: 14.94 },
  { text: "持って", start: 14.95, end: 15.55 },
  { text: "いかれてる", start: 15.55, end: 16.61 },
  { text: "って", start: 16.62, end: 16.8 },
  { text: "結構", start: 16.8, end: 17.18 },
  { text: "理不尽", start: 17.18, end: 17.76 },
  { text: "じゃない", start: 17.78, end: 18.58 },
  { text: "ですか", start: 18.58, end: 19.18 },
];
const seg30: TranscriptSegment = {
  start: 13.36,
  end: 19.22,
  text: words30.map((w) => w.text).join(""),
  words: words30,
};

test("maxChars 以下の segment は同一参照でそのまま返す(非改変・バイト等価)", () => {
  const short: TranscriptSegment = { start: 0, end: 2, text: "短いテロップ" };
  const out = splitLongCaptions([short], { maxChars: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0], short); // 同一参照
});

test("maxChars<=0 なら入力配列をそのまま返す(opt-in オフ)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 0 });
  assert.equal(out, [seg30].length === 1 ? out : out); // 型のため
  assert.equal(out.length, 1);
  assert.equal(out[0], seg30);
});

test("長い segment を文節末(って)で割り、各断片は maxChars 以下", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20, minChars: 8 });
  assert.ok(out.length >= 2, `2 断片以上に割れる: ${out.length}`);
  for (const s of out) {
    assert.ok([...s.text].length <= 20, `各断片 20 字以下: "${s.text}"(${[...s.text].length}字)`);
  }
  // 期待する割れ目: 「…って」で 1 枚目が終わる
  assert.equal(out[0].text, "時間もお金も両方持っていかれてるって");
  assert.equal(out[1].text, "結構理不尽じゃないですか");
});

test("分割後の文言を全連結すると元の text に一致(文字の欠落なし)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20 });
  assert.equal(out.map((s) => s.text).join(""), seg30.text);
});

test("時刻は語境界そのもの・時系列で連続(捏造しない)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20 });
  assert.equal(out[0].start, 13.36); // 先頭語の start
  assert.equal(out[out.length - 1].end, 19.18); // 末尾語の end
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].start >= out[i - 1].end, "断片は時系列・非重なり");
    assert.ok(out[i].end > out[i].start, "各断片は正の尺");
  }
});

test("words[] を各断片へ分配してカラオケ補助を保つ(語 atom のとき)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20 });
  for (const s of out) {
    assert.ok(s.words && s.words.length > 0, `words を保持: "${s.text}"`);
    assert.equal(s.words!.map((w) => w.text).join(""), s.text); // words と text が整合
    assert.equal(s.words![0].start, s.start);
    assert.equal(s.words![s.words!.length - 1].end, s.end);
  }
  // 分配された words の総数は元と一致(欠落・重複なし)
  const total = out.reduce((n, s) => n + (s.words?.length ?? 0), 0);
  assert.equal(total, words30.length);
});

test("words[] が無い長い segment は文字位置で線形補間して割る", () => {
  const noWords: TranscriptSegment = {
    start: 0,
    end: 10,
    text: "あいうえおかきくけこさしすせそたちつてとなにぬねの", // 25 字・句末語なし
  };
  const out = splitLongCaptions([noWords], { maxChars: 20, minChars: 8 });
  assert.ok(out.length >= 2, "文字数上限で割れる");
  assert.equal(out.map((s) => s.text).join(""), noWords.text);
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, 10);
  for (const s of out) assert.ok(!s.words, "words は付かない");
});

test("track/pos/style は全断片へ継承される", () => {
  const styled: TranscriptSegment = {
    ...seg30,
    track: 2,
    pos: { x: 100, y: 200 },
    style: { fontSizePx: 48 },
  };
  const out = splitLongCaptions([styled], { maxChars: 20 });
  assert.ok(out.length >= 2);
  for (const s of out) {
    assert.equal(s.track, 2);
    assert.deepEqual(s.pos, { x: 100, y: 200 });
    assert.deepEqual(s.style, { fontSizePx: 48 });
  }
});

/* ------------------------------------------------------------------ *
 * 2026-08-04 改訂(区切りの強さ + Knuth-Plass 型 DP)で固定した振る舞い
 * ------------------------------------------------------------------ */

/** whisper 風の語トークン列から segment を組む(語の秒数を並べて時刻を作る)。
 *  ["GAP", 0.7] を挟むとそこに無音の「間」が入る */
function buildSeg(toks: Array<[string, number]>): TranscriptSegment {
  const words: WordTiming[] = [];
  let t = 10;
  for (const [text, d] of toks) {
    if (text === "GAP") {
      t = Math.round((t + d) * 100) / 100;
      continue;
    }
    words.push({ text, start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100 });
    t = Math.round((t + d) * 100) / 100;
  }
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.text).join(""),
    words,
  };
}

test("区切りの強さ: 句点・述語の終止形は格助詞や「の」より強い(階層が逆転しない)", () => {
  assert.ok(suffixBreakStrength("終わりです。") > suffixBreakStrength("終わりです"));
  assert.ok(suffixBreakStrength("終わりです") > suffixBreakStrength("実行するから"));
  assert.ok(suffixBreakStrength("実行するから") > suffixBreakStrength("コマンドを"));
  assert.ok(suffixBreakStrength("コマンドを") > suffixBreakStrength("設定ファイルの"));
  // 手がかりの無い語中は最弱
  assert.ok(suffixBreakStrength("設定ファイルの") > suffixBreakStrength("プロジェク"));
});

test("区切りの強さ: 接尾は最長一致で 1 件だけ採る(「ました」が「た」等に負けない)", () => {
  assert.equal(suffixBreakStrength("実行しました"), suffixBreakStrength("完了しました"));
  assert.ok(suffixBreakStrength("実行しました") > suffixBreakStrength("実行するし"));
});

test("「間」の強さ: gapSec 未満は 0・pauseFullSec 以上は 1・その間は線形", () => {
  const cfg = { gapSec: 0.3, pauseFullSec: 0.8 };
  assert.equal(pauseBreakStrength(0.1, cfg), 0);
  assert.equal(pauseBreakStrength(0.3, cfg), 0);
  assert.equal(pauseBreakStrength(0.8, cfg), 1);
  assert.equal(pauseBreakStrength(2.0, cfg), 1);
  assert.ok(pauseBreakStrength(0.55, cfg) > 0.4 && pauseBreakStrength(0.55, cfg) < 0.6);
});

test("無音の「間」があればそこで折る(語境界の時刻をまたがない)", () => {
  const seg = buildSeg([
    ["それでは", 0.5], ["実際に", 0.4], ["コマンド", 0.5], ["を", 0.15],
    ["実行", 0.4], ["して", 0.3], ["みましょう", 0.6],
    ["GAP", 0.7],
    ["まず", 0.3], ["この", 0.25], ["設定", 0.4], ["ファイル", 0.45],
    ["を", 0.15], ["開いて", 0.5], ["ください", 0.6],
  ]);
  const out = splitLongCaptions([seg], { maxChars: 26 });
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "それでは実際にコマンドを実行してみましょう");
  assert.equal(out[1].text, "まずこの設定ファイルを開いてください");
});

test("文頭に立つ接続詞(でも)の直前で折る", () => {
  const seg = buildSeg([
    ["この", 0.25], ["方法", 0.35], ["は", 0.15], ["とても", 0.4], ["便利", 0.35],
    ["なん", 0.3], ["です", 0.3],
    ["でも", 0.35], ["注意", 0.35], ["しない", 0.4], ["と", 0.15], ["ハマり", 0.45], ["ます", 0.3],
  ]);
  const out = splitLongCaptions([seg], { maxChars: 20 });
  assert.equal(out.length, 2);
  assert.equal(out[1].text.startsWith("でも"), true, `接続詞から始まる: "${out[1].text}"`);
});

test("前の語へ密着する助詞(の・を)の直前では折らない", () => {
  const seg = buildSeg([
    ["エラー", 0.4], ["メッセージ", 0.5], ["の", 0.12], ["内容", 0.35], ["を", 0.15],
    ["よく", 0.3], ["読んで", 0.45],
    ["原因", 0.35], ["を", 0.15], ["特定", 0.4], ["する", 0.3], ["こと", 0.3],
    ["が", 0.15], ["大事", 0.35], ["です", 0.3],
  ]);
  const out = splitLongCaptions([seg], { maxChars: 20 });
  assert.ok(out.length >= 2);
  for (let i = 1; i < out.length; i++) {
    assert.ok(!/^(の|を|が|に|は|も)/.test(out[i].text), `助詞で始まらない: "${out[i].text}"`);
  }
});

test("行頭禁則: 小書き仮名・長音・撥音・句読点・閉じ括弧で断片を始めない", () => {
  // カタカナ語(小書き仮名を含む)が上限をまたぐ位置に来る長文
  const seg: TranscriptSegment = {
    start: 0,
    end: 12,
    text: "まず最初にこのコマンドを実行するとプロジェクトフォルダが作られるんですけどここで注意点があります",
  };
  const out = splitLongCaptions([seg], { maxChars: 26 });
  assert.ok(out.length >= 2);
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      !/^[ぁぃぅぇぉっゃゅょゎんァィゥェォッャュョヮンー〜…・、。！？]/.test(out[i].text),
      `行頭禁則を満たす: "${out[i].text}"`,
    );
  }
});

test("語の途中(英数字・カタカナの連なり)では折らない", () => {
  const seg: TranscriptSegment = {
    start: 0,
    end: 10,
    text: "この処理はClaudeCodeというツールでプロジェクトフォルダを自動生成できます",
  };
  const out = splitLongCaptions([seg], { maxChars: 20 });
  assert.equal(out.map((s) => s.text).join(""), seg.text);
  // "ClaudeCode" が 1 断片の中に丸ごと収まる(英字の連なりの途中では折らない)
  assert.ok(out.some((s) => s.text.includes("ClaudeCode")), out.map((s) => s.text).join(" | "));
});

test("弱い区切りに飛びつかず全体最適で折る(貪欲より断片長が揃う)", () => {
  // 助詞(を・に・は)が序盤に密集し、本当の切れ目は後半の「ので」にある文
  const seg: TranscriptSegment = {
    start: 0,
    end: 12,
    text: "設定を画面に反映するには再起動が必要なので一度アプリを終了してください",
  };
  const out = splitLongCaptions([seg], { maxChars: 24 });
  assert.equal(out.map((s) => s.text).join(""), seg.text);
  // 旧・貪欲実装は 24 字以内の「最後の助詞」で折るため極端に短い断片が出た。
  // DP 版は minChars(既定 floor(24*0.4)=9)を大きく下回る断片を作らない
  for (const s of out) {
    assert.ok([...s.text].length >= 9, `断片が短く刻まれない: "${s.text}"(${[...s.text].length}字)`);
    assert.ok([...s.text].length <= 24, `上限を超えない: "${s.text}"`);
  }
});

test("maxChars を上げると枚数が減る(粒度の唯一のつまみとして効く)", () => {
  const seg: TranscriptSegment = {
    start: 0,
    end: 14,
    text: "設定を画面に反映するには再起動が必要なので一度アプリを終了してくださいそれから再度実行します",
  };
  const narrow = splitLongCaptions([seg], { maxChars: 16 });
  const wide = splitLongCaptions([seg], { maxChars: 40 });
  assert.ok(narrow.length > wide.length, `maxChars を上げると枚数が減る: ${narrow.length} → ${wide.length}`);
  assert.equal(narrow.map((s) => s.text).join(""), seg.text);
  assert.equal(wide.map((s) => s.text).join(""), seg.text);
});

test("単一の語が maxChars を超えても必ず前進する(無限ループしない)", () => {
  const seg: TranscriptSegment = {
    start: 0,
    end: 4,
    text: "Supercalifragilisticexpialidocious な単語",
  };
  const out = splitLongCaptions([seg], { maxChars: 8 });
  assert.equal(out.map((s) => s.text).join(""), seg.text);
  assert.ok(out.length >= 2);
});

test("決定論: 同じ入力からは常に同じ分割になる", () => {
  const seg: TranscriptSegment = {
    start: 0,
    end: 12,
    text: "設定を画面に反映するには再起動が必要なので一度アプリを終了してください",
  };
  const a = splitLongCaptions([seg], { maxChars: 24 }).map((s) => s.text);
  const b = splitLongCaptions([seg], { maxChars: 24 }).map((s) => s.text);
  assert.deepEqual(a, b);
});

test("resolveCaptionSplitCfg: 省略値(minChars/gapSec/pauseFullSec/minDurationSec)", () => {
  assert.deepEqual(resolveCaptionSplitCfg({ maxChars: 26 }), {
    maxChars: 26,
    minChars: 10, // floor(26 * 0.4)
    gapSec: 0.3,
    pauseFullSec: 0.8,
    minDurationSec: 0.9,
    maxCharsLatin: 42, // round(26 * 1.6)
    minCharsLatin: 16, // floor(42 * 0.4)
  });
});

test("words[] なしでも句点の直後で折れる(次が接続語でも減点しない)", () => {
  const seg: TranscriptSegment = {
    start: 0,
    end: 10,
    text: "ここまでの準備が完了しました。ですから次の手順へ進みます",
  };
  const out = splitLongCaptions([seg], { maxChars: 24, minChars: 8 });
  assert.equal(out[0].text, "ここまでの準備が完了しました。");
  assert.equal(out[1].text, "ですから次の手順へ進みます");
});

test("句点でない位置では従来どおり行頭禁則が効く", () => {
  const seg: TranscriptSegment = {
    start: 0,
    end: 10,
    text: "ここまでの準備が完了しましたですから次の手順へ進みます",
  };
  const out = splitLongCaptions([seg], { maxChars: 24, minChars: 8 });
  assert.ok(out.every((s) => !s.text.startsWith("ですから")), out.map((s) => s.text).join(" | "));
});

/* ------------------------------------------------------------------ *
 * 空白区切りモード(英語。2026-09-24)
 * ------------------------------------------------------------------ */

/** whisper の英語トークン(buildWords が語頭の空白を trim した後)を模して segment を組む。
 *  text は語を空白で連結(whisper の text と同じ形)、words は空白なし */
function buildEnSeg(tokens: string[], glue: Set<number> = new Set()): TranscriptSegment {
  const words: WordTiming[] = tokens.map((text, i) => ({
    text,
    start: Math.round((i * 0.3) * 100) / 100,
    end: Math.round(((i + 1) * 0.3) * 100) / 100,
  }));
  // glue に入っている index の語は直前へ空白なしで連結("Isn" + "'t")
  const text = tokens.map((t, i) => (i === 0 || glue.has(i) ? t : ` ${t}`)).join("");
  return { start: 0, end: words[words.length - 1].end, text, words };
}

// 2026-08-07 の実データ(whisper 1 発話)
const enTokens = [
  "And", "when", "night", "falls", ",", "Mish", "in", "aga", "realizes", "he", "'s",
  "accomplished", "nothing", "again", "today", ".",
];
const enGlue = new Set([4, 6, 7, 10, 15]); // ",", "in", "aga", "'s", "." は前へ密着
const enSeg = buildEnSeg(enTokens, enGlue);

test("isSpaceDelimited: 英文は true・日本語文中の英単語程度では false", () => {
  assert.equal(isSpaceDelimited(enSeg.text), true);
  assert.equal(isSpaceDelimited("この処理は Claude Code というツールで自動生成できます"), false);
  assert.equal(isSpaceDelimited("NoSpacesAtAll"), false);
});

test("英語: trim 済み words[] でも語 atom を保ち、時刻は語境界・words と text が整合", () => {
  const out = splitLongCaptions([enSeg], { maxChars: 26 });
  assert.ok(out.length >= 2, out.map((s) => s.text).join(" | "));
  for (const s of out) {
    assert.ok(s.words && s.words.length > 0, `words を保持: "${s.text}"`);
    assert.equal(s.words![0].start, s.start);
    assert.equal(s.words![s.words!.length - 1].end, s.end);
    assert.equal(s.words!.map((w) => w.text).join(""), s.text.replace(/\s/g, ""));
  }
  assert.equal(out.reduce((n, s) => n + s.words!.length, 0), enTokens.length);
});

test("英語: 断片の前後に空白を残さず、空白で連結すると元の text に戻る", () => {
  const out = splitLongCaptions([enSeg], { maxChars: 26 });
  for (const s of out) assert.equal(s.text, s.text.trim());
  assert.equal(out.map((s) => s.text).join(" "), enSeg.text);
});

test("英語: 字数上限は maxCharsLatin で、読点の直後で折る(語の途中・文の途中で刻まない)", () => {
  const out = splitLongCaptions([enSeg], { maxChars: 26 });
  // 旧実装: "And when night falls, " / " Mishinaga realizes " / " he's accomplished " / ...
  assert.deepEqual(out.map((s) => s.text), [
    "And when night falls, Mishinaga realizes",
    "he's accomplished nothing again today.",
  ]);
  for (const s of out) assert.ok([...s.text].length <= 42);
});

test("英語: 節の頭(and/because 等)の前で折り、冠詞・前置詞の直後では折らない", () => {
  // 2026-08-07 の実データ(旧実装: "You stare aimlessly at  " / "the TV, watching other  " / ...)
  const seg = buildEnSeg(
    [
      "You", "stare", "aimlessly", "at", "the", "TV", ",", "watching", "other", "people's", "lives",
      "and", "getting", "caught", "up", "in", "news", "you", "don't", "even", "need", "to", "know", ".",
    ],
    new Set([6, 23]),
  );
  const out = splitLongCaptions([seg], { maxChars: 26 });
  assert.ok(out.length >= 2);
  assert.ok(out.some((s) => s.text.startsWith("and ")), out.map((s) => s.text).join(" | "));
  for (const s of out.slice(0, -1)) {
    assert.ok(!/\b(the|a|an|at|in|of|to)$/i.test(s.text), `結合語で終わらない: "${s.text}"`);
  }
});

test("英語: 語内のトークン境界(Isn|'t)では折らない", () => {
  const seg = buildEnSeg(
    ["Isn", "'t", "that", "truly", "ridiculous", "and", "isn", "'t", "it", "just", "a", "waste", "of", "time", "?"],
    new Set([1, 7, 14]),
  );
  const out = splitLongCaptions([seg], { maxChars: 20, maxCharsLatin: 24 });
  for (const s of out) assert.ok(!s.text.startsWith("'"), out.map((x) => x.text).join(" | "));
});

test("英語: 文間の空白が落ちた文末(succeed.I)でも文の切れ目として折る", () => {
  const seg = buildEnSeg(
    ["I", "want", "to", "succeed", ".", "I", "want", "to", "change", "my", "life", ".", "Fine", "words", "indeed", "."],
    new Set([4, 5, 11, 12, 15]),
  );
  assert.equal(seg.text, "I want to succeed.I want to change my life.Fine words indeed.");
  const out = splitLongCaptions([seg], { maxChars: 20, maxCharsLatin: 30 });
  assert.deepEqual(out.map((s) => s.text), ["I want to succeed.", "I want to change my life.", "Fine words indeed."]);
});

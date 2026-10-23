# dsh-goal-stall-guard

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) の goal が、作業を進めずに状況報告だけを繰り返す「空回り」に入ったときに気づいて、立て直すプラグインです。

goal は、AI がツールを呼ばずに返答を終えるとそのラウンドを終え、すぐ次のラウンドを始めます。AI が「今の範囲では達成済み、でも完了にはしない」といった宙ぶらりんになると、同じ報告を数秒ごとに書き続けます（ラウンド数の上限をなくしていると止まりません）。

## 動作

1. **空回りを数える**: goal のラウンドが、ツールを1回も呼ばずに終わったら「空回り」と数えます。ツールを使ったラウンド、ユーザーの指示、goal の作成・再開で数え直します。
2. **3ラウンド続いたら促す**: 次のラウンドから、AI へのコンテキストに「直近のラウンドは状況報告だけだった。具体的な次の作業をツールで行うか、goal を判断（目的を満たしていれば完了、進めない理由があれば blocked）して」という注記を入れます。空回りした報告は、最新の1つを除いて AI から見えなくします（ログには残ります）。
3. **さらに3ラウンド続いたら止める**: goal を止めて（blocked、理由 `no-progress`）、画面に知らせます。指示を具体的にして `/goal resume` で再開できます。

画面には、促したときに `⏸ goal の空回りを検知：…`、止めたときに `⛔ goal を停止：…` のカードが出ます（AI には送られません）。

## 設定（`cordis.patch.yml`）

| 項目 | 既定 | 意味 |
| --- | --- | --- |
| `nudgeAfterRounds` | 3 | 促すまでの空回りのラウンド数 |
| `blockAfterRounds` | 3 | 促した後、止めるまでの空回りのラウンド数 |

## 導入

```sh
dsh plugin --profile web add "file:$PWD"
```

## テスト

```sh
node scripts/link-dsh.mjs ~/.local/share/dsh/versions/0.2.1-rc.2/node_modules   # または DSH のソースcheckout
npm test
```

## ライセンス

MIT

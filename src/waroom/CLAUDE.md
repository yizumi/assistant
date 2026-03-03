# waroom/ - インシデント管理データ

Waroom（https://waroom.com）から取得したインシデントデータの保管ディレクトリ。月次レポート作成やインシデント傾向分析に使用する。

## ディレクトリ構成

```
src/waroom/                        # スクリプト・設定
├── CLAUDE.md                      # このファイル
├── waroom-download.sh             # MCP経由でWaroomからインシデントをダウンロードするスクリプト
├── monthly-summary-template.md    # 月次インシデント報告のテンプレート
└── .env                           # WAROOM_API_KEY を格納（git管理外）

output/waroom/                     # ダウンロードされたデータ（スクリプトの出力先）
└── YYYY-MM/                       # 月別ディレクトリ（2025-08〜）
    └── YYYY-MM-DD_<タイトル>.json  # 個別インシデントデータ
```

## インシデントJSON構造

各 `.json` ファイルは以下のフィールドを持つ:

| フィールド | 型 | 説明 |
|---|---|---|
| `uuid` | string | インシデントの一意識別子 |
| `title` | string | インシデントタイトル |
| `severity` | string | 重大度（`Level 0：情報`, `Level 1：軽微`, `Level 2：中程度`, `Level 3：重大`） |
| `status` | string | ステータス（`調査中`, `完了` など） |
| `root_cause` | string | 根本原因カテゴリ（`オペレーションミス`, `設定ミス` など） |
| `experimental` | bool | テスト用フラグ |
| `metrics` | object | 対応時間メトリクス（単位: 分） |
| `metrics.ttd` | number\|null | Time to Detect |
| `metrics.tta` | number\|null | Time to Acknowledge |
| `metrics.tti` | number\|null | Time to Investigate |
| `metrics.ttf` | number\|null | Time to Fix |
| `metrics.ttr` | number\|null | Time to Resolve |
| `service` | object | 対象サービス |
| `service.name` | string | サービス名（例: `111-SHIHARAI-COM`, `201-Breakthrow-Grid`） |
| `labels` | array | ラベル（各要素は `{name: string}`） |
| `created_at` | string | 作成日時（ISO 8601, JST） |
| `state_document` | string | インシデントの詳細文書（Markdown形式。概要・ユーザー影響・症状・原因・対応内容を含む） |
| `incident_slack_channel` | object | 関連Slackチャンネル |
| `incident_slack_channel.url` | string | SlackチャンネルURL |

## waroom-download.sh

Waroom MCP サーバー（`@topotal/waroom-mcp`）を起動し、JSON-RPC経由でインシデントを取得するスクリプト。

```bash
# 使い方
./waroom-download.sh 2026-02
```

- `.env` から `WAROOM_API_KEY` を読み込む
- 指定月のインシデント一覧を取得し、各詳細を `output/waroom/YYYY-MM/` 配下にJSON保存する
- 依存: `jq`, `npx`

## monthly-summary-template.md

月次インシデント報告書のテンプレート。取締役・執行役員レベル向けの報告形式で、以下を含む:

- 月次推移テーブル（Level別件数、オペレーション/システム分類）
- サービス別インシデント件数
- 当月の傾向分析
- 重大インシデントのピックアップ（最大3件）
- 来月までに片付けたいこと（最大3件）

出力ファイル名: `monthly-summary-yyyy-mm.md`

## データ規模

月あたり約25〜62件のインシデントデータを格納。2025年8月〜現在まで蓄積。

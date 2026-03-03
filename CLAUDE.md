# assistant

UPSIDER 社内の業務支援ツール・データ集約リポジトリ。Gmail のメール取得、Waroom のインシデント管理データ取得、プロジェクトごとの調査・ドキュメントを一箇所にまとめる。

## Tech Stack

- TypeScript (ES2022, ESM)
- Node.js (built-in modules のみ、ランタイム依存なし)
- pnpm (パッケージマネージャ)
- tsx (TypeScript 実行)

## Project Structure

```
assistant/
├── src/                         # ソースコード
│   ├── gmail/                   # Gmail API 連携スクリプト（OAuth + メール取得）
│   │   ├── config.ts            # 設定管理・トークンリフレッシュ
│   │   ├── gmail-accounts-add.ts # OAuth アカウント追加（ブラウザ認証フロー）
│   │   └── gmail-pull.ts        # メッセージ取得・スパム分類・インデックス構築
│   └── waroom/                  # Waroom インシデント取得スクリプト・設定
│       ├── waroom-download.sh   # MCP 経由でインシデントをダウンロード
│       └── .env                 # WAROOM_API_KEY（git 管理外）
├── docs/                        # 社内ドキュメント・参考資料
│   ├── hr/                      # HR 関連データ
│   └── mars/                    # Mars 関連データ
├── projects/                    # プロジェクト別の調査・ドキュメント
│   └── YYYYMMDD-<ProjectName>/  # 日付プレフィクス付きプロジェクトディレクトリ
├── output/                      # スクリプト出力先
│   ├── gmail/<email>/           # メールデータ（日別 JSON + index.json）
│   └── waroom/YYYY-MM/          # Waroom インシデント JSON データ
├── .config/                     # 設定ファイル（git 管理外）
│   └── gmail/config.json        # GCP OAuth 認証情報・アカウント設定
├── package.json
├── tsconfig.json
└── pnpm-lock.yaml
```

## Commands

```bash
# Gmail アカウントの OAuth 認証追加
pnpm gmail:accounts:add <email>

# Gmail メッセージの取得（過去6ヶ月分）
pnpm gmail:pull <email>

# Waroom インシデントの月次ダウンロード
./src/waroom/waroom-download.sh YYYY-MM
```

## Configuration

- `.config/gmail/config.json` — GCP OAuth クライアント ID/Secret、Gemini API キー（任意）、アカウント情報
- `src/waroom/.env` — `WAROOM_API_KEY`

これらのファイルには認証情報が含まれるため、絶対にコミットしないこと。

## Conventions

- ランタイム依存ライブラリを追加しない（Node.js 組み込み + native fetch のみ）
- 出力データは `output/` 配下に格納
- プロジェクトディレクトリは `YYYYMMDD-<ProjectName>` 形式で命名
- 各サブディレクトリに固有の CLAUDE.md がある場合はそちらも参照すること

# MyPlanner

내 일정·할 일을 AI가 함께 관리하는 데스크톱 앱입니다. 요구사항: Claude Docs의 「AI 일정·할 일 관리 요구사항 정의서」.

지금은 **1단계 · 앱 기반**입니다.

- **AI 연결 (개인 구독 계정)** — API 키 없이, 이 PC에 로그인한 공식 프로그램으로 AI를 씁니다. 앱은 비밀번호·토큰을 읽거나 저장하지 않습니다.
  - Claude: Claude Code (`claude auth login`)
  - ChatGPT: Codex (`codex login`)
  - Gemini: Google Antigravity CLI (`agy`)
  - 설정 → AI 연결에서 로그인 · 연결 끊기 · 설정 초기화. 프로그램이 없으면 앱이 공식 배포본을 받아 설치합니다.
- **AI에게 묻기** — 연결된 AI 중 하나를 골라 묻고, 답을 이어 받아 보여 줍니다. 기록은 앱 데이터 폴더의 `planner.db`에 남습니다.
- **업데이트** — 켤 때와 12시간마다 GitHub 릴리스의 최신 번호만 확인해 알려 줍니다. 설치는 사용자가 누를 때만 합니다.
  - 윈도우 zip판: ‘지금 업데이트’로 앱이 받아 바꿔 끼우고, 실패하면 이전 파일(`_previous`)로 되돌립니다.
  - 맥: 릴리스 페이지에서 새 dmg를 받습니다.
- **문제 기록** — `logs/app.log`, 설정 → 정보 → 진단 정보 복사 (질문·답 내용은 넣지 않음).

다음 단계: 구글 캘린더·Google Tasks → Outlook·Microsoft To Do → 할 일 한곳에 → 자동화 → 기기 동기화·Android.

## 가져온 코드

MyCollaboratorBots(그리고 그 원본인 MyDocSearch)의 모듈을 그대로 가져왔습니다. 고칠 때 두 앱을 함께 봅니다.

| 파일 | 하는 일 |
|---|---|
| `src/ai.js`, `src/agy.js`, `src/agy-hook.js` | 구독 CLI 찾기·설치·로그인·상태, 실행(stream-json), Gemini 도구 문지기 |
| `src/updater.js`, `src/version.js` | 새 버전 확인(HEAD /releases/latest, 6시간 캐시), 윈도우 zip 자동 업데이트 |
| `src/applog.js` | 문제 기록 |
| `scripts/bump-version.js`, `.github/workflows/build.yml` | 버전 올리기, 태그 → 빌드 → GitHub 릴리스 |

## 개발

이 맥에는 node가 PATH에 없어 Electron을 node로 씁니다. `node_modules`는 `DocSearch/pc/node_modules`를 가리키는 링크입니다 (저장소에 넣지 않음).

```bash
E=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
$E .                                   # 실행
ELECTRON_RUN_AS_NODE=1 $E test/unit-test.js   # 화면 없는 시험
$E test/app-test.js                    # 화면 시험 (가짜 AI)
```

## 배포

1. `CHANGELOG.md`의 `## 다음 버전` 아래에 바뀐 점을 적습니다.
2. `node scripts/bump-version.js patch`로 버전을 올립니다.
3. 커밋하고 `vX.Y.Z` 태그를 붙여 올립니다. GitHub Actions가 시험 → 윈도우(zip·설치판)·맥(dmg) 빌드 → 릴리스를 만듭니다.

코드 서명은 아직 하지 않았습니다 (맥은 ad-hoc 서명, 윈도우는 서명 없음).

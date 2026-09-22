# Consistency Guard (Jev)

캐릭터 응답 직후 Jev로 설정오류를 판정하고, 오류가 의심되면 별도 연결 프로필로 수정 지시문을 만든 뒤 메인 API로 수정본을 새 스와이프로 추가합니다.

## 설치

1. 확장: 이 폴더(server-plugin 제외)를 `SillyTavern/data/<사용자>/extensions/third-party/ST-Consistency-Guard/`
   또는 `SillyTavern/public/scripts/extensions/third-party/ST-Consistency-Guard/`에 넣습니다.
2. 서버 플러그인: `server-plugin/index.js`를 `SillyTavern/plugins/consistency-guard/index.js`로 복사합니다.
   제브 리콜 서버 플러그인(`plugins/jev-recall`)이 이미 설치되어 있으면 이 단계를 건너뛰어도 그 플러그인을 자동으로 재사용합니다.
3. `config.yaml`에서 `enableServerPlugins: true`를 확인하고 SillyTavern을 재시작한 뒤 브라우저를 강력 새로고침합니다.

## 연결 프로필

제브 리콜과 같은 프로필을 그대로 선택하면 됩니다.

- API: Custom (OpenAI-compatible)
- URL: `https://ai-gateway.vercel.sh/v1`
- 모델: `typesafe-ai/jev`
- 키: Vercel AI Gateway API 키

키는 확장 설정에 저장되지 않고, 서버 플러그인이 서버 안에서만 읽습니다.

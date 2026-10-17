# 텔레그램 오케 키트 · Paseo Telegram Kit

[English](README.en.md) · 안내 페이지: https://proof.getsundayable.com/telegram-kit/

휴대폰 텔레그램으로 내 Mac의 AI 에이전트들에게 일을 시키는 키트예요. 봇에게 메시지를 보내면 Paseo 안의 '오케'(오케스트레이터) 에이전트가 받아서 작업자 에이전트에게 일을 나눠 주고, 끝나면 텔레그램으로 결과를 알려 줘요.

```
휴대폰 텔레그램  ⇄  내 봇  ⇄  Mac의 Paseo  →  오케  →  작업자 에이전트들
```

## 이런 게 돼요

- 말하듯 보내면 오케가 알아서 작업자에게 맡기고, 끝나면 알려 줘요.
- 오케가 일하는 중에 보낸 메시지는 모아 뒀다가 순서대로 처리해요.
- 봇 메시지에 **답장**하면 무엇에 대한 답인지 알아들어요.
- 발송·게시·결제·삭제처럼 되돌리기 어려운 일은 먼저 물어봐요.
- 작업자가 권한을 물으면 텔레그램에 버튼으로 떠요.
- Claude 사용량이 다 차면 Codex 백업으로 넘어갔다가 돌아와요(Codex 로그인 시).
- `/ls`, `/to`, `/model`, `/status`, `/help` 같은 명령, 사진·파일 주고받기, 음성(선택).

## 설치 (약 5분)

필요한 것: Mac, [Paseo](https://paseo.sh) 앱, Claude Code(또는 Codex) 로그인, 휴대폰 텔레그램.

Paseo에서 새 에이전트(Claude Code)를 열고 아래 한 줄을 붙여 넣으세요.

```
텔레그램 오케를 설치해 줘. https://github.com/Sundayable/paseo-telegram-kit 에서 키트를 받아 ~/paseo-telegram-kit 에 두고, 그 안의 SKILL.md를 처음부터 끝까지 따라 해 줘.
```

에이전트가 나머지를 해요. 직접 하실 일은 이것뿐이에요.

1. 텔레그램 **@BotFather**에서 `/newbot`으로 봇 만들기 (에이전트가 누를 곳을 하나씩 알려 줘요)
2. 봇 비밀번호(토큰) 복사하기. **에이전트 채팅창에는 붙여넣지 마세요.**
3. 새 봇을 열고 **시작** 누르기
4. 마지막에 봇에게 `핑` 보내서 답 오는지 확인하기

필요하면 Node.js 설치(Mac 암호 입력)나 Claude 로그인을 한 번 하게 될 수 있어요.

## 안전

- 봇은 연결한 내 텔레그램 계정의 메시지에만 답해요.
- 토큰은 Mac 안의 비공개 파일(`~/.paseo/telegram-orchestrator/secrets.env`, 권한 600)에만 저장되고 화면에 출력되지 않아요.
- Mac이 켜져 있고 Paseo가 열려 있을 때만 동작해요.

## 제거

Paseo 에이전트에게 "텔레그램 오케 지워 줘"라고 하거나 `bash ~/paseo-telegram-kit/scripts/uninstall.sh`를 실행하세요. 파일은 휴지통으로 가요. 마지막으로 @BotFather에서 `/deletebot`으로 봇을 지우면 끝이에요.

## 폴더 구성

| 위치 | 내용 |
| --- | --- |
| `SKILL.md` | 에이전트가 따라 하는 설치·문제 해결·제거 안내 |
| `scripts/` | 점검(`doctor.sh`), 설정, 토큰 저장, 채팅 연결, 설치, 테스트, 제거 |
| `bridge/` | Paseo 플러그인(텔레그램 ↔ Paseo 연결) 소스 |
| `docs/` | 안내 페이지와 미리보기 이미지 소스 |

## 라이선스

MIT · © 2026 [Sundayable](https://sundayable.com). Paseo와 Telegram은 각 회사의 상표예요.

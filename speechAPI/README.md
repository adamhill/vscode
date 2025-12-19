# VS Code Speech API Documentation

> **Comprehensive guide for consuming the VS Code Speech API from extensions and internal workbench features**

This documentation covers how to use the VS Code Speech API to perform **speech-to-text (speech recognition)** in your VS Code extension or workbench contribution. It is based on the implementation by [@bpasero](https://github.com/bpasero) who created the voice infrastructure in VS Code.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](./architecture.md) - System design and component relationships
3. [Internal Consumer Guide](./internal-consumer-guide.md) - For VS Code workbench features
4. [Extension Consumer Guide](./extension-consumer-guide.md) - For third-party extensions
5. [Implementation Plan](./implementation-plan.md) - Step-by-step checklist

## Overview

The VS Code Speech API enables speech-to-text functionality through a provider/consumer architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Speech Provider Extension                    │
│              (e.g., ms-vscode.vscode-speech)                    │
│         Uses @vscode/node-speech / Azure Speech SDK             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ vscode.speech.registerSpeechProvider()
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      VS Code Speech Service                      │
│                        (ISpeechService)                          │
│                                                                  │
│  • Manages provider registration                                 │
│  • Creates speech-to-text sessions                               │
│  • Tracks active sessions via context keys                       │
│  • Handles extension activation ('onSpeech' event)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ createSpeechToTextSession()
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Speech Consumers                              │
│                                                                  │
│  Internal (workbench):           Extensions (proposed API):      │
│  • Chat Voice Actions            • Your extension can listen     │
│  • Terminal Voice                  to ISpeechService events      │
│  • Editor Dictation                (requires internal access)    │
│  • "Hey Code" keyword                                            │
└─────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### Speech Provider

An extension that **provides** speech recognition capabilities by implementing `vscode.SpeechProvider` and registering it via `vscode.speech.registerSpeechProvider()`. The official provider is [VS Code Speech](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech) which uses Azure Cognitive Services.

### Speech Consumer

Code that **consumes** speech recognition by calling `ISpeechService.createSpeechToTextSession()` and listening to `SpeechToTextStatus` events.

### Speech-to-Text Session

A live microphone session that emits events as speech is recognized:

- `Started` - Microphone activated
- `Recognizing` - Interim/partial recognition (text may change)
- `Recognized` - Final recognition (text is stable)
- `Stopped` - Session ended
- `Error` - Recognition failed

## Supported Languages

The Speech API supports 26+ languages including:

- English (US, UK, Australia, Canada, Ireland, India, New Zealand)
- German, French, Spanish, Italian, Portuguese
- Chinese (Simplified, Traditional), Japanese, Korean
- And more (see `SPEECH_LANGUAGES` in speechService.ts)

## Requirements

### For Speech Provider Extensions

- Must declare `speechProviders` contribution point in `package.json`
- Must use `enabledApiProposals: ["speech"]`
- Must handle `onSpeech` activation event

### For Internal Consumers (Workbench Features)

- Inject `ISpeechService` via dependency injection
- Use `CancellationTokenSource` for session lifecycle
- Subscribe to `SpeechToTextStatus` events

### For Extension Consumers

- Currently, extensions cannot directly consume speech (only provide)
- Internal workbench features have access to `ISpeechService`

## Quick Links

| Resource | Description |
|----------|-------------|
| [vscode.proposed.speech.d.ts](../src/vscode-dts/vscode.proposed.speech.d.ts) | Extension API definitions |
| [speechService.ts](../src/vs/workbench/contrib/speech/common/speechService.ts) | Service interface |
| [speechService.ts (browser)](../src/vs/workbench/contrib/speech/browser/speechService.ts) | Service implementation |
| [terminalVoice.ts](../src/vs/workbench/contrib/terminalContrib/voice/browser/terminalVoice.ts) | Consumer example |
| [voiceChatService.ts](../src/vs/workbench/contrib/chat/common/voiceChatService.ts) | Chat voice integration |

## Related Issues & PRs

Key issues by @bpasero that shaped the Voice API:

- [#197050](https://github.com/microsoft/vscode/issues/197050) - Voice command activation ("Hey Code")
- [#201330](https://github.com/microsoft/vscode/issues/201330) - Hold keybinding to talk
- [#205263](https://github.com/microsoft/vscode/issues/205263) - Editor dictation
- [#197837](https://github.com/microsoft/vscode/issues/197837) - Multi-language support

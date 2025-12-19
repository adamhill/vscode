# Extension Consumer Guide

This guide covers how to work with the VS Code Speech API from a **third-party extension**.

> **Important**: The Speech API is a **proposed API** and is only available in VS Code Insiders. Extensions using proposed APIs cannot be published to the Marketplace.

## Current Limitations

As of December 2024, the Speech API allows extensions to:

- ✅ **Provide** speech recognition capabilities (implement `SpeechProvider`)
- ❌ **Consume** speech recognition directly (no `vscode.speech.createSession()` API)

**This means**: External extensions cannot directly start speech recognition sessions. Only internal VS Code features (Chat, Terminal, Editor) can consume the `ISpeechService`.

### Why This Limitation Exists

The speech API was designed primarily to:

1. Allow alternative speech providers (not just Azure Speech SDK)
2. Enable the built-in VS Code voice features
3. Keep the API surface minimal until patterns are established

### Workarounds for Extensions

If your extension needs voice input, consider these approaches:

1. **Use VS Code's built-in voice commands** - Users can dictate into any text input
2. **Implement your own speech** - Use Web Speech API or native speech libraries
3. **Request API expansion** - File a feature request on [microsoft/vscode](https://github.com/microsoft/vscode/issues)

---

## For Speech Provider Extensions

If you're building an extension that **provides** speech recognition (alternative to `ms-vscode.vscode-speech`):

### Step 1: Enable the Proposed API

In your `package.json`:

```json
{
    "name": "my-speech-provider",
    "version": "1.0.0",
    "engines": {
        "vscode": "^1.85.0"
    },
    "enabledApiProposals": [
        "speech"
    ],
    "contributes": {
        "speechProviders": [
            {
                "name": "my-speech-provider",
                "description": "My custom speech recognition engine"
            }
        ]
    },
    "activationEvents": [
        "onSpeech"
    ]
}
```

### Step 2: Download the Proposed API Types

```bash
npx @vscode/dts dev
```

This downloads `vscode.proposed.speech.d.ts` to your project.

### Step 3: Implement the Speech Provider

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

    const provider: vscode.SpeechProvider = {

        // Speech-to-Text (Recognition)
        async provideSpeechToTextSession(
            token: vscode.CancellationToken,
            options?: vscode.SpeechToTextOptions
        ): Promise<vscode.SpeechToTextSession | undefined> {

            const emitter = new vscode.EventEmitter<vscode.SpeechToTextEvent>();

            // Initialize your speech recognition engine
            const recognizer = await initializeRecognizer(options?.language);

            // Handle cancellation
            token.onCancellationRequested(() => {
                recognizer.stop();
                emitter.fire({ status: vscode.SpeechToTextStatus.Stopped });
            });

            // Wire up recognition events
            recognizer.onStarted(() => {
                emitter.fire({ status: vscode.SpeechToTextStatus.Started });
            });

            recognizer.onRecognizing((text: string) => {
                emitter.fire({
                    status: vscode.SpeechToTextStatus.Recognizing,
                    text
                });
            });

            recognizer.onRecognized((text: string) => {
                emitter.fire({
                    status: vscode.SpeechToTextStatus.Recognized,
                    text
                });
            });

            recognizer.onError((error: Error) => {
                emitter.fire({
                    status: vscode.SpeechToTextStatus.Error,
                    text: error.message
                });
            });

            // Start recognition
            recognizer.start();

            return {
                onDidChange: emitter.event
            };
        },

        // Text-to-Speech (Synthesis) - optional
        async provideTextToSpeechSession(
            token: vscode.CancellationToken,
            options?: vscode.TextToSpeechOptions
        ): Promise<vscode.TextToSpeechSession | undefined> {

            const emitter = new vscode.EventEmitter<vscode.TextToSpeechEvent>();
            const synthesizer = await initializeSynthesizer(options?.language);

            return {
                onDidChange: emitter.event,
                synthesize: async (text: string) => {
                    emitter.fire({ status: vscode.TextToSpeechStatus.Started });
                    await synthesizer.speak(text);
                    emitter.fire({ status: vscode.TextToSpeechStatus.Stopped });
                }
            };
        },

        // Keyword Recognition ("Hey Code") - optional
        async provideKeywordRecognitionSession(
            token: vscode.CancellationToken
        ): Promise<vscode.KeywordRecognitionSession | undefined> {

            const emitter = new vscode.EventEmitter<vscode.KeywordRecognitionEvent>();
            const detector = await initializeKeywordDetector();

            token.onCancellationRequested(() => {
                detector.stop();
                emitter.fire({ status: vscode.KeywordRecognitionStatus.Stopped });
            });

            detector.onKeywordDetected((keyword: string) => {
                emitter.fire({
                    status: vscode.KeywordRecognitionStatus.Recognized,
                    text: keyword
                });
            });

            detector.start();

            return {
                onDidChange: emitter.event
            };
        }
    };

    // Register the provider
    const disposable = vscode.speech.registerSpeechProvider('my-speech', provider);
    context.subscriptions.push(disposable);
}
```

### Step 4: Run in VS Code Insiders

Since proposed APIs only work in Insiders:

```bash
code-insiders . --enable-proposed-api=my-publisher.my-speech-provider
```

Or add to `argv.json`:

```json
{
    "enable-proposed-api": ["my-publisher.my-speech-provider"]
}
```

---

## API Reference

### SpeechToTextStatus Enum

```typescript
enum SpeechToTextStatus {
    Started = 1,      // Microphone activated, ready to receive audio
    Recognizing = 2,  // Interim recognition - text may change
    Recognized = 3,   // Final recognition - text is stable
    Stopped = 4,      // Session ended normally
    Error = 5         // Recognition failed
}
```

### SpeechToTextEvent Interface

```typescript
interface SpeechToTextEvent {
    readonly status: SpeechToTextStatus;
    readonly text?: string;  // Present for Recognizing, Recognized, and Error
}
```

### SpeechToTextOptions Interface

```typescript
interface SpeechToTextOptions {
    readonly language?: string;  // BCP-47 language tag, e.g., "en-US", "de-DE"
}
```

### SpeechToTextSession Interface

```typescript
interface SpeechToTextSession {
    readonly onDidChange: Event<SpeechToTextEvent>;
}
```

### SpeechProvider Interface

```typescript
interface SpeechProvider {
    provideSpeechToTextSession(
        token: CancellationToken,
        options?: SpeechToTextOptions
    ): ProviderResult<SpeechToTextSession>;

    provideTextToSpeechSession(
        token: CancellationToken,
        options?: TextToSpeechOptions
    ): ProviderResult<TextToSpeechSession>;

    provideKeywordRecognitionSession(
        token: CancellationToken
    ): ProviderResult<KeywordRecognitionSession>;
}
```

---

## Using @vscode/node-speech

The official VS Code Speech extension uses [`@vscode/node-speech`](https://www.npmjs.com/package/@vscode/node-speech) which wraps Azure Cognitive Services Speech SDK. Here's how to use it:

### Installation

```bash
npm install @vscode/node-speech
```

### Example Implementation

```typescript
import * as vscode from 'vscode';
import { SpeechRecognizer, SpeechConfig } from '@vscode/node-speech';

export async function createAzureSpeechSession(
    token: vscode.CancellationToken,
    options?: vscode.SpeechToTextOptions
): Promise<vscode.SpeechToTextSession> {

    const emitter = new vscode.EventEmitter<vscode.SpeechToTextEvent>();

    // Configure Azure Speech SDK
    const config = SpeechConfig.fromSubscription(
        process.env.AZURE_SPEECH_KEY!,
        process.env.AZURE_SPEECH_REGION!
    );

    if (options?.language) {
        config.speechRecognitionLanguage = options.language;
    }

    // Create recognizer with default microphone
    const recognizer = new SpeechRecognizer(config);

    // Handle cancellation
    token.onCancellationRequested(() => {
        recognizer.stopContinuousRecognitionAsync();
    });

    // Wire up events
    recognizer.sessionStarted = () => {
        emitter.fire({ status: vscode.SpeechToTextStatus.Started });
    };

    recognizer.recognizing = (_, event) => {
        emitter.fire({
            status: vscode.SpeechToTextStatus.Recognizing,
            text: event.result.text
        });
    };

    recognizer.recognized = (_, event) => {
        if (event.result.text) {
            emitter.fire({
                status: vscode.SpeechToTextStatus.Recognized,
                text: event.result.text
            });
        }
    };

    recognizer.canceled = (_, event) => {
        emitter.fire({
            status: vscode.SpeechToTextStatus.Error,
            text: event.errorDetails
        });
    };

    recognizer.sessionStopped = () => {
        emitter.fire({ status: vscode.SpeechToTextStatus.Stopped });
    };

    // Start continuous recognition
    await recognizer.startContinuousRecognitionAsync();

    return {
        onDidChange: emitter.event
    };
}
```

---

## Supported Languages

The Speech API supports the following language codes:

| Code | Language |
|------|----------|
| `da-DK` | Danish (Denmark) |
| `de-DE` | German (Germany) |
| `en-AU` | English (Australia) |
| `en-CA` | English (Canada) |
| `en-GB` | English (United Kingdom) |
| `en-IE` | English (Ireland) |
| `en-IN` | English (India) |
| `en-NZ` | English (New Zealand) |
| `en-US` | English (United States) |
| `es-ES` | Spanish (Spain) |
| `es-MX` | Spanish (Mexico) |
| `fr-CA` | French (Canada) |
| `fr-FR` | French (France) |
| `hi-IN` | Hindi (India) |
| `it-IT` | Italian (Italy) |
| `ja-JP` | Japanese (Japan) |
| `ko-KR` | Korean (South Korea) |
| `nl-NL` | Dutch (Netherlands) |
| `pt-BR` | Portuguese (Brazil) |
| `pt-PT` | Portuguese (Portugal) |
| `ru-RU` | Russian (Russia) |
| `sv-SE` | Swedish (Sweden) |
| `tr-TR` | Turkish (Türkiye) |
| `zh-CN` | Chinese (Simplified, China) |
| `zh-HK` | Chinese (Traditional, Hong Kong) |
| `zh-TW` | Chinese (Traditional, Taiwan) |

---

## Testing Your Provider

### Manual Testing

1. Install your extension in VS Code Insiders
2. Enable the proposed API flag
3. Open Chat or use terminal dictation
4. VS Code will use your provider instead of the default

### Automated Testing

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Speech Provider Tests', () => {

    test('should emit Started event', async () => {
        const provider = new MySpeechProvider();
        const cts = new vscode.CancellationTokenSource();

        const session = await provider.provideSpeechToTextSession(cts.token);
        assert.ok(session);

        const events: vscode.SpeechToTextEvent[] = [];
        session.onDidChange(e => events.push(e));

        // Wait for Started event
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(events[0]?.status, vscode.SpeechToTextStatus.Started);

        cts.cancel();
    });

    test('should handle cancellation', async () => {
        const provider = new MySpeechProvider();
        const cts = new vscode.CancellationTokenSource();

        const session = await provider.provideSpeechToTextSession(cts.token);

        const events: vscode.SpeechToTextEvent[] = [];
        session!.onDidChange(e => events.push(e));

        // Cancel immediately
        cts.cancel();

        await new Promise(resolve => setTimeout(resolve, 100));

        const lastEvent = events[events.length - 1];
        assert.strictEqual(lastEvent?.status, vscode.SpeechToTextStatus.Stopped);
    });
});
```

---

## Common Issues

### "API proposal 'speech' is not registered"

Ensure you have:

1. Added `"enabledApiProposals": ["speech"]` to `package.json`
2. Downloaded the proposed API types with `npx @vscode/dts dev`
3. Running in VS Code Insiders with `--enable-proposed-api`

### Provider Not Being Used

Check that:

1. Your extension is activated (check Output > Extension Host)
2. The `speechProviders` contribution is in `package.json`
3. The `onSpeech` activation event is declared
4. No other speech provider has higher priority

### Microphone Permission Denied

- On macOS: System Preferences > Security & Privacy > Microphone
- On Windows: Settings > Privacy > Microphone
- On Linux: Check PulseAudio/PipeWire permissions

---

## Future API Expansion

There's interest in expanding the API to allow extensions to **consume** speech. If this is important for your use case, consider:

1. Filing a [feature request](https://github.com/microsoft/vscode/issues/new?template=feature_request.md)
2. Describing your use case in detail
3. Following the `workbench-voice` label for updates

Potential future APIs might include:

```typescript
// Hypothetical future API
vscode.speech.createSpeechToTextSession(options): Promise<SpeechToTextSession>;
vscode.speech.hasSpeechProvider: boolean;
vscode.speech.onDidChangeHasSpeechProvider: Event<void>;
```

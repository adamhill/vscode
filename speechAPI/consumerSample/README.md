# Speech Consumer Sample Extension

This is a sample VS Code extension demonstrating the **Speech Consumer API** - a proposed API that allows extensions to consume speech-to-text capabilities from speech providers.

## Features

- **Sidebar Panel**: A dedicated view in the activity bar for speech transcription
- **Microphone Toggle**: Click to start/stop speech recognition
- **Live Transcription**: See interim results as you speak, with final text appended to the transcript
- **Provider Detection**: Automatically detects when a speech provider is available
- **Clear Function**: Clear the transcript with one click

## Requirements

This extension requires:

1. **VS Code 1.96.0+** (for proposed API support)
2. **VS Code Speech Extension** - Install from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech)
3. **Proposed API enabled** - This extension uses the `speechConsumer` proposed API

## How It Works

### Architecture

```text
┌─────────────────────────────────────────────┐
│          Webview (Sidebar Panel)            │
│  ┌───────────────────────────────────────┐  │
│  │  🎤 Microphone Button                 │  │
│  │  📝 Transcript Text Area              │  │
│  │  💬 Interim Text Display              │  │
│  └───────────────────────────────────────┘  │
│                    │                        │
│              postMessage()                  │
│                    ▼                        │
├─────────────────────────────────────────────┤
│         Extension Host (extension.ts)       │
│  ┌───────────────────────────────────────┐  │
│  │  SpeechTranscriptionViewProvider      │  │
│  │  - Manages WebviewView                │  │
│  │  - Handles speech session lifecycle   │  │
│  └───────────────────────────────────────┘  │
│                    │                        │
│     vscode.speech.createSpeechToTextSession │
│                    ▼                        │
├─────────────────────────────────────────────┤
│              VS Code Speech API             │
│  ┌───────────────────────────────────────┐  │
│  │  ISpeechService (internal)            │  │
│  │  - Routes to registered provider      │  │
│  └───────────────────────────────────────┘  │
│                    │                        │
│                    ▼                        │
├─────────────────────────────────────────────┤
│          Speech Provider Extension          │
│  (e.g., VS Code Speech Extension)           │
│  - Azure Cognitive Services                 │
│  - Local speech recognition                 │
└─────────────────────────────────────────────┘
```

### Speech Consumer API Usage

```typescript
// Check if a speech provider is available
if (!vscode.speech.hasSpeechProvider) {
    console.log('No speech provider - prompt user to install one');
    return;
}

// Create a speech-to-text session
const session = await vscode.speech.createSpeechToTextSession({
    language: 'en-US'
});

// Consume events via AsyncIterable
try {
    for await (const event of session.events) {
        switch (event.status) {
            case vscode.SpeechToTextStatus.Recognizing:
                // Interim result - update UI
                console.log('Interim:', event.text);
                break;

            case vscode.SpeechToTextStatus.Recognized:
                // Final result - append to transcript
                console.log('Final:', event.text);
                break;

            case vscode.SpeechToTextStatus.Error:
                console.error('Error:', event.text);
                break;

            case vscode.SpeechToTextStatus.Stopped:
                console.log('Session stopped');
                break;
        }
    }
} finally {
    session.dispose();
}
```

## Running the Extension

1. **Open in VS Code**

   ```bash
   cd speechAPI/consumerSample
   code .
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Compile**

   ```bash
   npm run compile
   ```

4. **Run with Extension Host**
   - Press `F5` to launch the Extension Development Host
   - Note: You may need to run VS Code with `--enable-proposed-api speech-consumer-sample`

5. **Test**
   - Click the microphone icon in the activity bar
   - If no speech provider is installed, click the link to install VS Code Speech
   - Click the microphone button to start listening
   - Speak into your microphone
   - Click again to stop

## Development

### File Structure

```text
speechAPI/consumerSample/
├── .vscode/
│   ├── launch.json      # Debug configuration
│   └── tasks.json       # Build tasks
├── media/
│   ├── main.js          # Webview script
│   ├── main.css         # Webview styles
│   ├── reset.css        # CSS reset
│   └── vscode.css       # VS Code theme integration
├── src/
│   └── extension.ts     # Extension entry point
├── package.json         # Extension manifest
├── tsconfig.json        # TypeScript configuration
└── README.md            # This file
```

### Key Components

1. **`SpeechTranscriptionViewProvider`** - Implements `WebviewViewProvider` for the sidebar panel
2. **`main.js`** - Webview script handling UI state and message passing
3. **Message Protocol**:
   - `toggleListening` - Start/stop speech recognition
   - `clearTranscript` - Clear the text area
   - `listeningState` - Update UI for listening state
   - `providerState` - Update UI for provider availability
   - `interim` / `final` - Speech recognition results

## Proposed API

This extension uses the `speechConsumer` proposed API which adds:

- `vscode.speech.hasSpeechProvider: boolean` - Check provider availability
- `vscode.speech.onDidChangeSpeechProvider: Event<void>` - Provider availability changed
- `vscode.speech.createSpeechToTextSession(options?)` - Create a transcription session

See [implementation-plan.md](../consumerAPI/implementation-plan.md) for the full API specification.

## License

MIT License - See LICENSE file for details.

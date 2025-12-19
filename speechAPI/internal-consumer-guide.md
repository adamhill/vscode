# Internal Consumer Guide

This guide is for developers creating **VS Code workbench features** that consume the Speech API internally. This includes features like Chat Voice, Terminal Voice, Editor Dictation, etc.

> **Note**: This guide requires access to internal VS Code services via dependency injection. For external extension development, see [Extension Consumer Guide](./extension-consumer-guide.md).

## Prerequisites

1. Access to `ISpeechService` via dependency injection
2. Understanding of VS Code's disposable pattern
3. Familiarity with `CancellationTokenSource` for session lifecycle

## Core Pattern

The fundamental pattern for consuming speech in a workbench feature:

```typescript
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { DisposableStore, toDisposable } from 'vs/base/common/lifecycle';
import { ISpeechService, SpeechToTextStatus } from 'vs/workbench/contrib/speech/common/speechService';

class MyVoiceFeature {
    private cancellationTokenSource: CancellationTokenSource | undefined;

    constructor(
        @ISpeechService private readonly speechService: ISpeechService,
    ) {}

    async startListening(): Promise<void> {
        // 1. Stop any existing session
        this.stopListening();

        // 2. Create cancellation token for session control
        this.cancellationTokenSource = new CancellationTokenSource();

        // 3. Create speech-to-text session
        const session = await this.speechService.createSpeechToTextSession(
            this.cancellationTokenSource.token,
            'my-feature'  // Context for telemetry
        );

        // 4. Subscribe to recognition events
        session.onDidChange(event => {
            switch (event.status) {
                case SpeechToTextStatus.Started:
                    // Microphone activated - show recording UI
                    this.showRecordingIndicator();
                    break;

                case SpeechToTextStatus.Recognizing:
                    // Interim text - update UI with partial results
                    if (event.text) {
                        this.updatePreviewText(event.text);
                    }
                    break;

                case SpeechToTextStatus.Recognized:
                    // Final text - commit to input
                    if (event.text) {
                        this.commitText(event.text);
                    }
                    break;

                case SpeechToTextStatus.Stopped:
                    // Session ended - cleanup
                    this.stopListening();
                    break;

                case SpeechToTextStatus.Error:
                    // Recognition failed
                    this.handleError(event.text);
                    this.stopListening();
                    break;
            }
        });
    }

    stopListening(): void {
        this.cancellationTokenSource?.cancel();
        this.cancellationTokenSource?.dispose();
        this.cancellationTokenSource = undefined;
        this.hideRecordingIndicator();
    }
}
```

## Complete Example: Terminal Voice Session

Here's the actual implementation from `terminalVoice.ts`, annotated with explanations:

```typescript
import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Disposable, DisposableStore, toDisposable } from 'vs/base/common/lifecycle';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import {
    ISpeechService,
    SpeechToTextStatus,
    AccessibilityVoiceSettingId,
    ISpeechToTextEvent
} from 'vs/workbench/contrib/speech/common/speechService';
import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { TerminalContextKeys } from 'vs/workbench/contrib/terminal/common/terminalContextKey';

export class TerminalVoiceSession extends Disposable {

    // Current transcribed input
    private _input: string = '';

    // Singleton pattern - one session at a time
    private static _instance: TerminalVoiceSession | undefined = undefined;

    // Auto-submit scheduler
    private _acceptTranscriptionScheduler: RunOnceScheduler | undefined;

    // Context key for UI state
    private readonly _terminalDictationInProgress: IContextKey<boolean>;

    // Session lifecycle
    private _cancellationTokenSource: CancellationTokenSource | undefined;
    private readonly _disposables: DisposableStore;

    static getInstance(instantiationService: IInstantiationService): TerminalVoiceSession {
        if (!TerminalVoiceSession._instance) {
            TerminalVoiceSession._instance = instantiationService.createInstance(TerminalVoiceSession);
        }
        return TerminalVoiceSession._instance;
    }

    constructor(
        @ISpeechService private readonly _speechService: ISpeechService,
        @ITerminalService private readonly _terminalService: ITerminalService,
        @IConfigurationService private readonly _configurationService: IConfigurationService,
        @IContextKeyService contextKeyService: IContextKeyService,
    ) {
        super();

        // Stop session if terminal changes
        this._register(this._terminalService.onDidChangeActiveInstance(() => this.stop()));
        this._register(this._terminalService.onDidDisposeInstance(() => this.stop()));

        this._disposables = this._register(new DisposableStore());

        // Bind context key for when clauses
        this._terminalDictationInProgress = TerminalContextKeys.terminalDictationInProgress.bindTo(contextKeyService);
    }

    async start(): Promise<void> {
        // Always stop existing session first
        this.stop();

        // Get timeout setting (default 5000ms)
        let voiceTimeout = this._configurationService.getValue<number>(
            AccessibilityVoiceSettingId.SpeechTimeout
        );
        if (!isNumber(voiceTimeout) || voiceTimeout < 0) {
            voiceTimeout = 5000; // SpeechTimeoutDefault
        }

        // Create auto-submit scheduler
        this._acceptTranscriptionScheduler = this._disposables.add(
            new RunOnceScheduler(() => {
                this._sendText();
                this.stop();
            }, voiceTimeout)
        );

        // Create cancellation token for session control
        this._cancellationTokenSource = new CancellationTokenSource();
        this._register(toDisposable(() => this._cancellationTokenSource?.dispose(true)));

        // === KEY: Create the speech-to-text session ===
        const session = await this._speechService.createSpeechToTextSession(
            this._cancellationTokenSource?.token,
            'terminal'  // Context identifier for telemetry
        );

        // Subscribe to recognition events
        this._disposables.add(session.onDidChange((e) => {
            if (this._cancellationTokenSource?.token.isCancellationRequested) {
                return;  // Ignore events after cancellation
            }

            switch (e.status) {
                case SpeechToTextStatus.Started:
                    // Set context key so UI knows we're recording
                    this._terminalDictationInProgress.set(true);
                    this._createDecoration();  // Show mic icon
                    break;

                case SpeechToTextStatus.Recognizing:
                    // Interim results - show ghost text
                    this._updateInput(e);
                    this._renderGhostText(e);

                    // Cancel auto-submit while actively speaking
                    if (voiceTimeout > 0) {
                        this._acceptTranscriptionScheduler!.cancel();
                    }
                    break;

                case SpeechToTextStatus.Recognized:
                    // Final text - send immediately
                    this._updateInput(e);
                    this._sendText();

                    // Reset for next recognition
                    this._ghostText?.dispose();
                    this._input = '';
                    break;

                case SpeechToTextStatus.Stopped:
                    this.stop();
                    break;
            }
        }));
    }

    stop(send?: boolean): void {
        if (send) {
            this._acceptTranscriptionScheduler?.cancel();
            this._sendText();
        }

        // Cleanup UI elements
        this._ghostText = undefined;
        this._decoration?.dispose();
        this._marker?.dispose();

        // Cancel the session
        this._cancellationTokenSource?.cancel();
        this._disposables.clear();

        // Reset state
        this._input = '';
        this._terminalDictationInProgress.reset();
    }

    private _sendText(): void {
        this._terminalService.activeInstance?.sendText(this._input, false);
    }

    private _updateInput(e: ISpeechToTextEvent): void {
        if (e.text) {
            // Clean up punctuation and convert spoken symbols
            let input = e.text.replaceAll(/[.,?;!]/g, '');

            // Convert "slash" to "/" etc.
            const symbolMap: Record<string, string> = {
                'slash': '/',
                'backslash': '\\',
                'dot': '.',
                'dollar': '$',
                'percent': '%',
                // ... more mappings
            };

            for (const [word, symbol] of Object.entries(symbolMap)) {
                input = input.replace(new RegExp('\\b' + word + '\\b', 'gi'), symbol);
            }

            this._input = ' ' + input;
        }
    }
}
```

## VoiceChatService Wrapper Pattern

For chat-specific functionality, VS Code wraps the speech service with additional logic:

```typescript
import { ISpeechService, SpeechToTextStatus, ISpeechToTextEvent } from 'vs/workbench/contrib/speech/common/speechService';
import { IChatAgentService } from 'vs/workbench/contrib/chat/common/chatAgents';

export interface IVoiceChatTextEvent extends ISpeechToTextEvent {
    // Indicates the text is just prefixes like "@workspace /fix"
    readonly waitingForInput?: boolean;
}

export class VoiceChatService extends Disposable implements IVoiceChatService {

    constructor(
        @ISpeechService private readonly speechService: ISpeechService,
        @IChatAgentService private readonly chatAgentService: IChatAgentService,
        @IContextKeyService contextKeyService: IContextKeyService
    ) {
        super();
        this.voiceChatInProgress = VoiceChatInProgress.bindTo(contextKeyService);
    }

    async createVoiceChatSession(
        token: CancellationToken,
        options: IVoiceChatSessionOptions
    ): Promise<IVoiceChatSession> {

        const disposables = new DisposableStore();
        const emitter = disposables.add(new Emitter<IVoiceChatTextEvent>());

        // Create underlying speech session
        const session = await this.speechService.createSpeechToTextSession(token, 'chat');

        // Build phrase mappings for agents/commands
        // e.g., "at workspace" -> "@workspace"
        const phrases = this.createPhrases(options.model);

        let detectedAgent = false;
        let detectedSlashCommand = false;

        disposables.add(session.onDidChange(e => {
            switch (e.status) {
                case SpeechToTextStatus.Recognizing:
                case SpeechToTextStatus.Recognized: {
                    if (e.text) {
                        // Transform "at workspace slash fix" -> "@workspace /fix"
                        const transformed = this.transformAgentPhrases(
                            e.text,
                            phrases,
                            detectedAgent,
                            detectedSlashCommand
                        );

                        emitter.fire({
                            status: e.status,
                            text: transformed.text,
                            waitingForInput: transformed.waitingForInput
                        });

                        if (e.status === SpeechToTextStatus.Recognized) {
                            detectedAgent = transformed.detectedAgent;
                            detectedSlashCommand = transformed.detectedSlashCommand;
                        }
                    }
                    break;
                }
                default:
                    emitter.fire(e);
            }
        }));

        return { onDidChange: emitter.event };
    }
}
```

## Session Controller Pattern

The voice chat actions use a controller pattern for session management:

```typescript
interface IVoiceChatSessionController {
    readonly onDidAcceptInput: Event<unknown>;
    readonly onDidHideInput: Event<unknown>;
    readonly context: VoiceChatSessionContext;
    readonly scopedContextKeyService: IContextKeyService;

    updateState(state: VoiceChatSessionState): void;
    focusInput(): void;
    acceptInput(): Promise<IChatResponseModel | undefined>;
    updateInput(text: string): void;
    getInput(): string;
    setInputPlaceholder(text: string): void;
    clearInputPlaceholder(): void;
}

class VoiceChatSessions {
    private currentSession: IActiveVoiceChatSession | undefined;

    async start(
        controller: IVoiceChatSessionController,
        context?: IChatExecuteActionContext
    ): Promise<IVoiceChatSession> {

        // Stop any existing session
        this.stop();

        const cts = new CancellationTokenSource();
        const session = await this.voiceChatService.createVoiceChatSession(cts.token, {
            usesAgents: controller.context !== 'inline',
            model: context?.widget?.viewModel?.model
        });

        // Auto-accept after timeout
        const acceptScheduler = new RunOnceScheduler(
            () => this.accept(sessionId),
            voiceChatTimeout
        );

        session.onDidChange(({ status, text, waitingForInput }) => {
            switch (status) {
                case SpeechToTextStatus.Started:
                    controller.updateState(VoiceChatSessionState.Started);
                    controller.setInputPlaceholder("I'm listening...");
                    break;

                case SpeechToTextStatus.Recognizing:
                    controller.updateInput(text);
                    acceptScheduler.cancel();  // Don't auto-submit while speaking
                    break;

                case SpeechToTextStatus.Recognized:
                    controller.updateInput(text);
                    if (!waitingForInput) {
                        acceptScheduler.schedule();  // Start auto-submit timer
                    }
                    break;

                case SpeechToTextStatus.Stopped:
                    this.stop(sessionId, controller.context);
                    break;
            }
        });

        return session;
    }

    stop(sessionId?: number, context?: string): void {
        if (this.currentSession?.id === sessionId) {
            this.currentSession.controller.clearInputPlaceholder();
            this.currentSession.controller.updateState(VoiceChatSessionState.Stopped);
            this.currentSession.disposables.dispose();
            this.currentSession = undefined;
        }
    }

    accept(sessionId: number): void {
        if (this.currentSession?.id === sessionId && this.currentSession.hasRecognizedInput) {
            this.currentSession.controller.acceptInput();
        }
    }
}
```

## Checking Provider Availability

Before starting a session, check if a speech provider is available:

```typescript
// Check if any speech provider is registered
if (!this.speechService.hasSpeechProvider) {
    // Prompt user to install VS Code Speech extension
    const result = await this.dialogService.confirm({
        message: 'Would you like to install the VS Code Speech extension?',
        primaryButton: 'Install Extension'
    });

    if (result.confirmed) {
        await this.commandService.executeCommand(
            'workbench.extensions.installExtension',
            'ms-vscode.vscode-speech'
        );
    }
    return;
}

// Listen for provider changes
this.speechService.onDidChangeHasSpeechProvider(() => {
    this.updateUIState();
});
```

## Context Keys for UI

Use context keys to show/hide UI elements:

```typescript
// In your contribution
import { HasSpeechProvider, SpeechToTextInProgress } from 'vs/workbench/contrib/speech/common/speechService';

// In menu contributions (package.json style in code)
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'myFeature.startVoice',
            title: 'Start Voice Input',
            icon: Codicon.mic,
            precondition: ContextKeyExpr.and(
                HasSpeechProvider,                    // Provider available
                SpeechToTextInProgress.negate()       // Not already recording
            ),
            menu: [{
                id: MenuId.MyFeatureToolbar,
                when: HasSpeechProvider,
                group: 'navigation'
            }]
        });
    }
});
```

## Error Handling

```typescript
session.onDidChange(event => {
    if (event.status === SpeechToTextStatus.Error) {
        // Error message is in event.text
        this.logService.error(`Speech recognition error: ${event.text}`);

        // Show user-friendly message
        this.notificationService.error(
            localize('speechError', "Speech recognition failed. Please try again.")
        );

        // Cleanup
        this.stopListening();
    }
});
```

## Configuration Integration

Respect user settings:

```typescript
import { AccessibilityVoiceSettingId, SPEECH_LANGUAGE_CONFIG } from 'vs/workbench/contrib/speech/common/speechService';

// Get speech timeout setting
const timeout = this.configurationService.getValue<number>(
    AccessibilityVoiceSettingId.SpeechTimeout
);

// Get configured language
const language = this.configurationService.getValue<string>(
    SPEECH_LANGUAGE_CONFIG
);

// Listen for setting changes
this.configurationService.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(AccessibilityVoiceSettingId.SpeechTimeout)) {
        this.updateTimeout();
    }
});
```

## Best Practices

1. **Always stop existing sessions** before starting new ones
2. **Use DisposableStore** for managing event subscriptions
3. **Set context keys** so UI reflects recording state
4. **Handle all status cases** including Error and Stopped
5. **Respect cancellation** - check `token.isCancellationRequested`
6. **Clean up resources** in stop/dispose methods
7. **Use telemetry context** to track feature usage
8. **Provide visual feedback** during recording (mic icons, placeholders)
9. **Implement auto-submit timeout** based on user settings

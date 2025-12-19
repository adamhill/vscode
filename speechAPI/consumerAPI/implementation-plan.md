# VS Code Speech Consumer API - Extension Point Implementation Plan

## Executive Summary

This document provides a comprehensive implementation plan for adding a **Speech Consumer API** to VS Code's extension system. Currently, the `vscode.speech` namespace only allows extensions to **provide** speech capabilities. This PR will enable extensions to **consume** the internal `ISpeechService` for speech-to-text transcription.

### Key Decisions

1. **Full Protocol Approach** - Not command-based; follows VS Code's native extension API patterns
2. **AsyncIterable<> Streaming** - Events streamed as `AsyncIterable<SpeechToTextEvent>`
3. **No Explicit User Consent** - Development experiment (can add consent later)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Extension Process (ExtHost)                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Extension Code                                                          ││
│  │  ─────────────────                                                       ││
│  │  const session = await vscode.speech.createSpeechToTextSession();        ││
│  │  for await (const event of session.events) {                             ││
│  │    console.log(event.text);                                              ││
│  │  }                                                                       ││
│  └────────────────────────────────┬────────────────────────────────────────┘│
│                                   │                                          │
│  ┌────────────────────────────────▼────────────────────────────────────────┐│
│  │  ExtHostSpeech.createSpeechToTextSession()                              ││
│  │  ─────────────────────────────────────────                              ││
│  │  1. Generate unique sessionId                                           ││
│  │  2. Create AsyncIterableSource<SpeechToTextEvent>                       ││
│  │  3. Store in consumerSessions Map                                       ││
│  │  4. Call proxy.$createConsumerSpeechToTextSession(sessionId, opts)      ││
│  │  5. Return SpeechToTextSession with asyncIterable                       ││
│  └────────────────────────────────┬────────────────────────────────────────┘│
└───────────────────────────────────│─────────────────────────────────────────┘
                                    │ RPC Protocol
                                    │ IPC Channel
┌───────────────────────────────────│─────────────────────────────────────────┐
│                          Main Process (MainThread)                           │
│  ┌────────────────────────────────▼────────────────────────────────────────┐│
│  │  MainThreadSpeech.$createConsumerSpeechToTextSession()                  ││
│  │  ─────────────────────────────────────────────                          ││
│  │  1. Create CancellationTokenSource for session                          ││
│  │  2. Call speechService.createSpeechToTextSession(token, context)        ││
│  │  3. Subscribe to session.onDidChange                                    ││
│  │  4. Forward events: proxy.$onConsumerSpeechToTextEvent(sessionId, evt)  ││
│  │  5. Store session in consumerSpeechToTextSessions Map                   ││
│  └────────────────────────────────┬────────────────────────────────────────┘│
│                                   │                                          │
│  ┌────────────────────────────────▼────────────────────────────────────────┐│
│  │  ISpeechService (Internal Service)                                      ││
│  │  ─────────────────────────────────                                      ││
│  │  - createSpeechToTextSession() → ISpeechToTextSession                   ││
│  │  - Manages active sessions, providers, context keys                     ││
│  │  - Fires events: onDidStartSpeechToTextSession, onDidEndSession         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Reference Implementation: Language Models API

The `vscode.lm` (Language Models) API serves as the primary reference for this implementation. It demonstrates how to expose an internal service to extensions with streaming responses.

### Key Patterns from `vscode.lm`

**ExtHost (Consumer Side):**

```typescript
// extHostLanguageModels.ts - Pattern to follow
async selectLanguageModels(extension: IExtensionDescription, selector: vscode.LanguageModelChatSelector) {
    const models = await this._proxy.$selectChatModels({ ...selector, extension: extension.identifier });
    // ... return models
}

// Streaming response handling
async $acceptResponsePart(requestId: number, chunk: SerializableObjectWithBuffers<IChatResponsePart>): Promise<void> {
    const data = this._pendingRequest.get(requestId);
    if (data) {
        data.res.handleResponsePart(chunk.value);
    }
}
```

**MainThread (Service Bridge):**

```typescript
// mainThreadLanguageModels.ts - Pattern to follow
async $tryStartChatRequest(...): Promise<void> {
    const response = await this._chatProviderService.sendChatRequest(...);
    // Stream parts back to ExtHost
    for await (const part of response.stream) {
        await this._proxy.$acceptResponsePart(requestId, new SerializableObjectWithBuffers(part));
    }
}
```

---

## Implementation Files

### File 1: Protocol Definitions

**File:** `src/vs/workbench/api/common/extHost.protocol.ts`

**Location:** Lines ~1307-1325 (near existing speech shapes)

#### Current Code

```typescript
export interface MainThreadSpeechShape extends IDisposable {
    $registerProvider(handle: number, identifier: string, metadata: ISpeechProviderMetadata): void;
    $unregisterProvider(handle: number): void;
    $emitSpeechToTextEvent(session: number, event: ISpeechToTextEvent): void;
    $emitTextToSpeechEvent(session: number, event: ITextToSpeechEvent): void;
    $emitKeywordRecognitionEvent(session: number, event: IKeywordRecognitionEvent): void;
}

export interface ExtHostSpeechShape {
    $createSpeechToTextSession(handle: number, session: number, language?: string): Promise<void>;
    $cancelSpeechToTextSession(session: number): Promise<void>;
    $createTextToSpeechSession(handle: number, session: number, language?: string): Promise<void>;
    $synthesizeSpeech(session: number, text: string): Promise<void>;
    $cancelTextToSpeechSession(session: number): Promise<void>;
    $createKeywordRecognitionSession(handle: number, session: number): Promise<void>;
    $cancelKeywordRecognitionSession(session: number): Promise<void>;
}
```

#### Additions

```typescript
// Add to MainThreadSpeechShape
export interface MainThreadSpeechShape extends IDisposable {
    // ... existing provider methods ...

    // === NEW: Consumer API Methods ===
    /**
     * Called by ExtHost to create a new speech-to-text consumer session.
     * MainThread will use ISpeechService.createSpeechToTextSession() internally.
     */
    $createConsumerSpeechToTextSession(sessionId: number, options?: ISpeechToTextConsumerOptions): Promise<void>;

    /**
     * Called by ExtHost to cancel an active consumer session.
     */
    $cancelConsumerSpeechToTextSession(sessionId: number): Promise<void>;

    /**
     * Query if a speech provider is currently available.
     */
    $hasSpeechProvider(): Promise<boolean>;
}

// Add to ExtHostSpeechShape
export interface ExtHostSpeechShape {
    // ... existing provider callbacks ...

    // === NEW: Consumer API Callbacks ===
    /**
     * MainThread calls this to forward speech-to-text events to the extension.
     */
    $onConsumerSpeechToTextEvent(sessionId: number, event: ISpeechToTextEvent): void;

    /**
     * MainThread calls this when a consumer session ends (success or error).
     */
    $onConsumerSpeechToTextSessionEnd(sessionId: number, error?: SerializedError): void;

    /**
     * MainThread notifies ExtHost when speech provider availability changes.
     */
    $onDidChangeSpeechProviderAvailability(available: boolean): void;
}

// New DTO for consumer options
export interface ISpeechToTextConsumerOptions {
    language?: string;
    context?: string;
}
```

---

### File 2: MainThread Speech Handler

**File:** `src/vs/workbench/api/browser/mainThreadSpeech.ts`

#### Current Structure (Reference)

```typescript
@extHostNamedCustomer(MainContext.MainThreadSpeech)
export class MainThreadSpeech implements MainThreadSpeechShape {
    private readonly proxy: ExtHostSpeechShape;
    private readonly providerRegistrations = new Map<number, IDisposable>();
    private readonly speechToTextSessions = new Map<number, SpeechToTextSession>();
    // ...
}
```

#### Additions

```typescript
import { AsyncIterableSource } from '../../../base/common/async.js';
import { transformErrorForSerialization, SerializedError } from '../../../base/common/errors.js';

type ConsumerSpeechToTextSession = {
    readonly cts: CancellationTokenSource;
    readonly disposables: DisposableStore;
};

@extHostNamedCustomer(MainContext.MainThreadSpeech)
export class MainThreadSpeech implements MainThreadSpeechShape {
    // ... existing fields ...

    // === NEW: Consumer session tracking ===
    private readonly consumerSpeechToTextSessions = new Map<number, ConsumerSpeechToTextSession>();
    private readonly hasSpeechProviderListener: IDisposable;

    constructor(
        extHostContext: IExtHostContext,
        @ISpeechService private readonly speechService: ISpeechService,
        @ILogService private readonly logService: ILogService
    ) {
        this.proxy = extHostContext.getProxy(ExtHostContext.ExtHostSpeech);

        // === NEW: Listen for provider availability changes ===
        this.hasSpeechProviderListener = this.speechService.onDidChangeHasSpeechProvider(() => {
            this.proxy.$onDidChangeSpeechProviderAvailability(this.speechService.hasSpeechProvider);
        });
    }

    // === NEW: Consumer API Implementation ===

    async $createConsumerSpeechToTextSession(sessionId: number, options?: ISpeechToTextConsumerOptions): Promise<void> {
        this.logService.trace('[Speech] Extension creating consumer speech-to-text session', sessionId);

        if (!this.speechService.hasSpeechProvider) {
            throw new Error('No speech provider available');
        }

        const disposables = new DisposableStore();
        const cts = new CancellationTokenSource();
        disposables.add(toDisposable(() => cts.dispose(true)));

        // Store session for cancellation
        this.consumerSpeechToTextSessions.set(sessionId, { cts, disposables });

        try {
            // Create session using internal speech service
            const session = await this.speechService.createSpeechToTextSession(
                cts.token,
                options?.context ?? 'extension'
            );

            // Forward all events to ExtHost
            disposables.add(session.onDidChange(event => {
                if (cts.token.isCancellationRequested) {
                    return;
                }

                this.proxy.$onConsumerSpeechToTextEvent(sessionId, event);

                // Check for terminal states
                if (event.status === SpeechToTextStatus.Stopped || event.status === SpeechToTextStatus.Error) {
                    this.cleanupConsumerSession(sessionId);
                    this.proxy.$onConsumerSpeechToTextSessionEnd(
                        sessionId,
                        event.status === SpeechToTextStatus.Error
                            ? transformErrorForSerialization(new Error(event.text ?? 'Speech recognition error'))
                            : undefined
                    );
                }
            }));

        } catch (error) {
            this.cleanupConsumerSession(sessionId);
            throw error;
        }
    }

    async $cancelConsumerSpeechToTextSession(sessionId: number): Promise<void> {
        this.logService.trace('[Speech] Extension cancelling consumer speech-to-text session', sessionId);
        this.cleanupConsumerSession(sessionId);
    }

    async $hasSpeechProvider(): Promise<boolean> {
        return this.speechService.hasSpeechProvider;
    }

    private cleanupConsumerSession(sessionId: number): void {
        const session = this.consumerSpeechToTextSessions.get(sessionId);
        if (session) {
            session.disposables.dispose();
            this.consumerSpeechToTextSessions.delete(sessionId);
        }
    }

    dispose(): void {
        // ... existing disposal ...
        this.hasSpeechProviderListener.dispose();

        // Clean up all consumer sessions
        for (const session of this.consumerSpeechToTextSessions.values()) {
            session.disposables.dispose();
        }
        this.consumerSpeechToTextSessions.clear();
    }
}
```

---

### File 3: ExtHost Speech Handler

**File:** `src/vs/workbench/api/common/extHostSpeech.ts`

#### Current Structure

```typescript
export class ExtHostSpeech implements ExtHostSpeechShape {
    private static ID_POOL = 1;
    private readonly proxy: MainThreadSpeechShape;
    private readonly providers = new Map<number, vscode.SpeechProvider>();
    private readonly sessions = new Map<number, CancellationTokenSource>();
    // ...
}
```

#### Full Updated Implementation

```typescript
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { AsyncIterableSource } from '../../../base/common/async.js';
import { transformErrorFromSerialization, SerializedError } from '../../../base/common/errors.js';
import { ExtHostSpeechShape, IMainContext, MainContext, MainThreadSpeechShape, ISpeechToTextConsumerOptions } from './extHost.protocol.js';
import type * as vscode from 'vscode';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';

// === NEW: Consumer Session Type ===
type ConsumerSpeechToTextSession = {
    readonly stream: AsyncIterableSource<vscode.SpeechToTextEvent>;
    readonly cts: CancellationTokenSource;
};

export class ExtHostSpeech implements ExtHostSpeechShape {

    private static ID_POOL = 1;

    private readonly proxy: MainThreadSpeechShape;

    // Provider-side tracking (existing)
    private readonly providers = new Map<number, vscode.SpeechProvider>();
    private readonly sessions = new Map<number, CancellationTokenSource>();
    private readonly synthesizers = new Map<number, vscode.TextToSpeechSession>();

    // === NEW: Consumer-side tracking ===
    private readonly consumerSessions = new Map<number, ConsumerSpeechToTextSession>();
    private readonly _onDidChangeSpeechProvider = new Emitter<void>();
    readonly onDidChangeSpeechProvider: Event<void> = this._onDidChangeSpeechProvider.event;
    private _hasSpeechProvider: boolean = false;

    constructor(mainContext: IMainContext) {
        this.proxy = mainContext.getProxy(MainContext.MainThreadSpeech);

        // Initialize provider availability
        this.proxy.$hasSpeechProvider().then(available => {
            this._hasSpeechProvider = available;
        });
    }

    // === NEW: Consumer API ===

    get hasSpeechProvider(): boolean {
        return this._hasSpeechProvider;
    }

    /**
     * Creates a speech-to-text session that extensions can consume.
     * Returns an AsyncIterable that streams SpeechToTextEvent objects.
     */
    async createSpeechToTextSession(
        extension: IExtensionDescription,
        options?: vscode.SpeechToTextOptions
    ): Promise<vscode.SpeechToTextSession> {
        // Check proposed API access
        checkProposedApiEnabled(extension, 'speechConsumer');

        const sessionId = ExtHostSpeech.ID_POOL++;
        const stream = new AsyncIterableSource<vscode.SpeechToTextEvent>();
        const cts = new CancellationTokenSource();

        // Store session for event handling
        this.consumerSessions.set(sessionId, { stream, cts });

        // Request session from MainThread
        try {
            await this.proxy.$createConsumerSpeechToTextSession(sessionId, {
                language: options?.language,
                context: 'extension'
            });
        } catch (error) {
            this.consumerSessions.delete(sessionId);
            throw error;
        }

        // Return session object with AsyncIterable
        const events = stream.asyncIterable;

        return {
            events,
            dispose: () => {
                cts.dispose(true);
                this.proxy.$cancelConsumerSpeechToTextSession(sessionId);
                this.consumerSessions.delete(sessionId);
            }
        };
    }

    // === NEW: ExtHost callbacks for consumer sessions ===

    $onConsumerSpeechToTextEvent(sessionId: number, event: vscode.SpeechToTextEvent): void {
        const session = this.consumerSessions.get(sessionId);
        if (session && !session.cts.token.isCancellationRequested) {
            session.stream.emitOne(event);
        }
    }

    $onConsumerSpeechToTextSessionEnd(sessionId: number, error?: SerializedError): void {
        const session = this.consumerSessions.get(sessionId);
        if (session) {
            if (error) {
                session.stream.reject(transformErrorFromSerialization(error));
            } else {
                session.stream.resolve();
            }
            this.consumerSessions.delete(sessionId);
        }
    }

    $onDidChangeSpeechProviderAvailability(available: boolean): void {
        this._hasSpeechProvider = available;
        this._onDidChangeSpeechProvider.fire();
    }

    // === Existing Provider Implementation (unchanged) ===

    async $createSpeechToTextSession(handle: number, session: number, language?: string): Promise<void> {
        // ... existing implementation ...
    }

    async $cancelSpeechToTextSession(session: number): Promise<void> {
        // ... existing implementation ...
    }

    // ... rest of existing provider methods ...

    registerProvider(extension: ExtensionIdentifier, identifier: string, provider: vscode.SpeechProvider): IDisposable {
        // ... existing implementation ...
    }
}
```

---

### File 4: API Namespace Implementation

**File:** `src/vs/workbench/api/common/extHost.api.impl.ts`

#### Current Speech Namespace (Lines ~1620-1628)

```typescript
const speech: typeof vscode.speech = {
    registerSpeechProvider(id, provider) {
        return extHostSpeech.registerProvider(extension.identifier, id, provider);
    }
};
```

#### Updated Implementation

```typescript
// === UPDATED: Speech namespace with consumer API ===
const speech: typeof vscode.speech = {
    // Existing provider registration
    registerSpeechProvider(id, provider) {
        return extHostSpeech.registerProvider(extension.identifier, id, provider);
    },

    // === NEW: Consumer API ===

    /**
     * Check if a speech provider is available.
     */
    get hasSpeechProvider(): boolean {
        return extHostSpeech.hasSpeechProvider;
    },

    /**
     * Event fired when speech provider availability changes.
     */
    get onDidChangeSpeechProvider(): vscode.Event<void> {
        return extHostSpeech.onDidChangeSpeechProvider;
    },

    /**
     * Create a speech-to-text session to transcribe audio from the microphone.
     * Returns a session with an AsyncIterable of speech events.
     *
     * @param options - Optional settings like language preference
     * @returns A session object with events and dispose method
     */
    createSpeechToTextSession(options?: vscode.SpeechToTextOptions): Thenable<vscode.SpeechToTextSession> {
        checkProposedApiEnabled(extension, 'speechConsumer');
        return extHostSpeech.createSpeechToTextSession(extension, options);
    }
};
```

---

### File 5: Proposed API Types

**File:** `src/vscode-dts/vscode.proposed.speechConsumer.d.ts` (NEW FILE)

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

    /**
     * A speech-to-text session that provides transcription events.
     * This is the consumer-facing API for using speech recognition.
     */
    export interface SpeechToTextSession {
        /**
         * An async iterable that yields speech-to-text events.
         * Iterate with `for await (const event of session.events) { ... }`
         *
         * The iterable completes when:
         * - Speech recognition stops naturally
         * - An error occurs
         * - The session is disposed
         */
        readonly events: AsyncIterable<SpeechToTextEvent>;

        /**
         * Dispose this session and stop speech recognition.
         */
        dispose(): void;
    }

    export namespace speech {
        /**
         * Whether a speech provider is currently available.
         * This is `true` when an extension has registered a speech provider.
         */
        export const hasSpeechProvider: boolean;

        /**
         * Event fired when the availability of speech providers changes.
         * Listen to this to know when speech capabilities become available or unavailable.
         */
        export const onDidChangeSpeechProvider: Event<void>;

        /**
         * Create a new speech-to-text session.
         *
         * This starts listening to the default microphone and transcribes speech to text.
         * The returned session provides an async iterable of events that can be consumed
         * with a for-await-of loop.
         *
         * @example
         * ```typescript
         * const session = await vscode.speech.createSpeechToTextSession();
         * try {
         *     for await (const event of session.events) {
         *         if (event.status === vscode.SpeechToTextStatus.Recognized) {
         *             console.log('Final:', event.text);
         *         } else if (event.status === vscode.SpeechToTextStatus.Recognizing) {
         *             console.log('Interim:', event.text);
         *         }
         *     }
         * } finally {
         *     session.dispose();
         * }
         * ```
         *
         * @param options - Optional configuration for the session
         * @returns A promise that resolves to a speech-to-text session
         */
        export function createSpeechToTextSession(options?: SpeechToTextOptions): Thenable<SpeechToTextSession>;
    }
}
```

---

### File 6: Register Proposed API

**File:** `src/vs/workbench/services/extensions/common/extensionsApiProposals.ts`

Add to the proposals registry:

```typescript
// Add to the allApiProposals object
export const allApiProposals = Object.freeze<{ [proposalName: string]: Readonly<IApiProposalDescription> }>({
    // ... existing proposals ...

    speechConsumer: {
        proposal: 'https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.speechConsumer.d.ts',
        version: 1
    },

    // ... rest of proposals ...
});
```

---

## Implementation Checklist

### Phase 1: Protocol Layer

- [ ] Update `extHost.protocol.ts` with new interface methods
- [ ] Add `ISpeechToTextConsumerOptions` DTO
- [ ] Ensure proper import of `SerializedError` type

### Phase 2: MainThread Implementation

- [ ] Add consumer session tracking map in `MainThreadSpeech`
- [ ] Implement `$createConsumerSpeechToTextSession`
- [ ] Implement `$cancelConsumerSpeechToTextSession`
- [ ] Implement `$hasSpeechProvider`
- [ ] Add provider availability listener
- [ ] Update `dispose()` to clean up consumer sessions

### Phase 3: ExtHost Implementation

- [ ] Add consumer session tracking in `ExtHostSpeech`
- [ ] Add `hasSpeechProvider` getter and event
- [ ] Implement `createSpeechToTextSession` method
- [ ] Implement `$onConsumerSpeechToTextEvent` callback
- [ ] Implement `$onConsumerSpeechToTextSessionEnd` callback
- [ ] Implement `$onDidChangeSpeechProviderAvailability` callback

### Phase 4: API Surface

- [ ] Update speech namespace in `extHost.api.impl.ts`
- [ ] Add proposed API check for consumer methods
- [ ] Create `vscode.proposed.speechConsumer.d.ts`
- [ ] Register proposal in `extensionsApiProposals.ts`

### Phase 5: Testing

- [ ] Unit tests for ExtHostSpeech consumer methods
- [ ] Unit tests for MainThreadSpeech consumer handlers
- [ ] Integration test with mock speech provider
- [ ] Test error handling and session cleanup

### Phase 6: Documentation

- [ ] Update extension API documentation
- [ ] Add JSDoc comments to all new methods
- [ ] Create example extension demonstrating usage

---

## Testing Strategy

### Unit Test Example (ExtHostSpeech)

```typescript
// src/vs/workbench/api/test/common/extHostSpeech.test.ts

suite('ExtHostSpeech Consumer API', () => {
    let extHostSpeech: ExtHostSpeech;
    let mainThreadProxy: MockProxy<MainThreadSpeechShape>;

    setup(() => {
        mainThreadProxy = mock<MainThreadSpeechShape>();
        mainThreadProxy.$hasSpeechProvider.mockResolvedValue(true);
        mainThreadProxy.$createConsumerSpeechToTextSession.mockResolvedValue(undefined);

        const mainContext: IMainContext = {
            getProxy: () => mainThreadProxy
        };

        extHostSpeech = new ExtHostSpeech(mainContext);
    });

    test('createSpeechToTextSession returns session with events', async () => {
        const extension = { identifier: { value: 'test.extension' } } as IExtensionDescription;

        const session = await extHostSpeech.createSpeechToTextSession(extension);

        assert.ok(session.events);
        assert.ok(typeof session.dispose === 'function');
    });

    test('events are streamed via AsyncIterable', async () => {
        const extension = { identifier: { value: 'test.extension' } } as IExtensionDescription;

        const session = await extHostSpeech.createSpeechToTextSession(extension);

        // Simulate MainThread sending events
        extHostSpeech.$onConsumerSpeechToTextEvent(1, {
            status: SpeechToTextStatus.Recognizing,
            text: 'hello'
        });

        extHostSpeech.$onConsumerSpeechToTextEvent(1, {
            status: SpeechToTextStatus.Recognized,
            text: 'hello world'
        });

        extHostSpeech.$onConsumerSpeechToTextSessionEnd(1, undefined);

        // Consume events
        const events: SpeechToTextEvent[] = [];
        for await (const event of session.events) {
            events.push(event);
        }

        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].text, 'hello');
        assert.strictEqual(events[1].text, 'hello world');
    });

    test('session dispose cancels recognition', async () => {
        const extension = { identifier: { value: 'test.extension' } } as IExtensionDescription;

        const session = await extHostSpeech.createSpeechToTextSession(extension);
        session.dispose();

        assert.ok(mainThreadProxy.$cancelConsumerSpeechToTextSession.calledOnceWith(1));
    });
});
```

---

## Extension Usage Example

```typescript
// Example extension using the Speech Consumer API

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Check provider availability
    if (!vscode.speech.hasSpeechProvider) {
        vscode.window.showWarningMessage('No speech provider available');

        // Wait for provider to become available
        const disposable = vscode.speech.onDidChangeSpeechProvider(() => {
            if (vscode.speech.hasSpeechProvider) {
                vscode.window.showInformationMessage('Speech is now available!');
                disposable.dispose();
            }
        });
        context.subscriptions.push(disposable);
        return;
    }

    // Register command to start speech recognition
    const startCommand = vscode.commands.registerCommand('myExtension.startSpeech', async () => {
        const session = await vscode.speech.createSpeechToTextSession({
            language: 'en-US'
        });

        context.subscriptions.push({
            dispose: () => session.dispose()
        });

        // Process speech events
        try {
            for await (const event of session.events) {
                switch (event.status) {
                    case vscode.SpeechToTextStatus.Started:
                        vscode.window.showInformationMessage('Listening...');
                        break;

                    case vscode.SpeechToTextStatus.Recognizing:
                        // Interim result - could show in status bar
                        console.log('Interim:', event.text);
                        break;

                    case vscode.SpeechToTextStatus.Recognized:
                        // Final result - insert into editor
                        const editor = vscode.window.activeTextEditor;
                        if (editor && event.text) {
                            editor.edit(editBuilder => {
                                editBuilder.insert(editor.selection.active, event.text!);
                            });
                        }
                        break;

                    case vscode.SpeechToTextStatus.Error:
                        vscode.window.showErrorMessage(`Speech error: ${event.text}`);
                        break;

                    case vscode.SpeechToTextStatus.Stopped:
                        vscode.window.showInformationMessage('Speech recognition stopped');
                        break;
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Speech failed: ${error}`);
        }
    });

    context.subscriptions.push(startCommand);
}
```

---

## Key Files Summary

| File | Purpose | Changes |
|------|---------|---------|
| `extHost.protocol.ts` | IPC contract | Add consumer methods to both shapes |
| `mainThreadSpeech.ts` | MainThread handler | Implement consumer session handlers |
| `extHostSpeech.ts` | ExtHost handler | Add consumer API + callbacks |
| `extHost.api.impl.ts` | API factory | Expose consumer methods in namespace |
| `vscode.proposed.speechConsumer.d.ts` | TypeScript types | New file with consumer types |
| `extensionsApiProposals.ts` | Proposal registry | Register `speechConsumer` proposal |

---

## Future Considerations

1. **User Consent** - Add consent flow before accessing microphone
2. **Text-to-Speech Consumer** - Similar pattern for `createTextToSpeechSession`
3. **Keyword Recognition Consumer** - Expose keyword recognition
4. **Multiple Providers** - Allow extension to select specific provider
5. **Audio Source Selection** - Let extensions choose audio input device

---

## References

- [ExtHostLanguageModels](../src/vs/workbench/api/common/extHostLanguageModels.ts) - Consumer API pattern
- [MainThreadLanguageModels](../src/vs/workbench/api/browser/mainThreadLanguageModels.ts) - MainThread bridge pattern
- [AsyncIterableSource](../src/vs/base/common/async.ts#L2203) - Streaming primitive
- [ISpeechService](../src/vs/workbench/contrib/speech/common/speechService.ts) - Internal service interface
- [vscode.proposed.speech.d.ts](../src/vscode-dts/vscode.proposed.speech.d.ts) - Current provider API types

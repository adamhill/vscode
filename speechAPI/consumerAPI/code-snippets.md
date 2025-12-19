# Speech Consumer API - Code Snippets Reference

This file contains ready-to-copy code snippets for implementing the Speech Consumer API.
Use alongside the main implementation-plan.md document.

---

## 1. Protocol Additions (`extHost.protocol.ts`)

### Import additions (if needed)

```typescript
import { SerializedError } from '../../../base/common/errors.js';
```

### New DTO

```typescript
export interface ISpeechToTextConsumerOptions {
 language?: string;
 context?: string;
}
```

### MainThreadSpeechShape additions

```typescript
// Consumer API - Extensions calling into ISpeechService
$createConsumerSpeechToTextSession(sessionId: number, options?: ISpeechToTextConsumerOptions): Promise<void>;
$cancelConsumerSpeechToTextSession(sessionId: number): Promise<void>;
$hasSpeechProvider(): Promise<boolean>;
```

### ExtHostSpeechShape additions

```typescript
// Consumer API - MainThread callbacks to ExtHost
$onConsumerSpeechToTextEvent(sessionId: number, event: ISpeechToTextEvent): void;
$onConsumerSpeechToTextSessionEnd(sessionId: number, error?: SerializedError): void;
$onDidChangeSpeechProviderAvailability(available: boolean): void;
```

---

## 2. MainThreadSpeech Consumer Implementation

### New imports

```typescript
import { transformErrorForSerialization } from '../../../base/common/errors.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { SpeechToTextStatus } from '../../contrib/speech/common/speechService.js';
```

### New type

```typescript
type ConsumerSpeechToTextSession = {
 readonly cts: CancellationTokenSource;
 readonly disposables: DisposableStore;
};
```

### New class members

```typescript
private readonly consumerSpeechToTextSessions = new Map<number, ConsumerSpeechToTextSession>();
private readonly hasSpeechProviderListener: IDisposable;
```

### Constructor addition

```typescript
// In constructor, after this.proxy = ...
this.hasSpeechProviderListener = this.speechService.onDidChangeHasSpeechProvider(() => {
 this.proxy.$onDidChangeSpeechProviderAvailability(this.speechService.hasSpeechProvider);
});
```

### New methods

```typescript
async $createConsumerSpeechToTextSession(sessionId: number, options?: ISpeechToTextConsumerOptions): Promise<void> {
 this.logService.trace('[Speech] Extension creating consumer session', sessionId);

 if (!this.speechService.hasSpeechProvider) {
  throw new Error('No speech provider available');
 }

 const disposables = new DisposableStore();
 const cts = new CancellationTokenSource();
 disposables.add(toDisposable(() => cts.dispose(true)));

 this.consumerSpeechToTextSessions.set(sessionId, { cts, disposables });

 try {
  const session = await this.speechService.createSpeechToTextSession(
   cts.token,
   options?.context ?? 'extension'
  );

  disposables.add(session.onDidChange(event => {
   if (cts.token.isCancellationRequested) {
    return;
   }

   this.proxy.$onConsumerSpeechToTextEvent(sessionId, event);

   if (event.status === SpeechToTextStatus.Stopped || event.status === SpeechToTextStatus.Error) {
    this.cleanupConsumerSession(sessionId);
    this.proxy.$onConsumerSpeechToTextSessionEnd(
     sessionId,
     event.status === SpeechToTextStatus.Error
      ? transformErrorForSerialization(new Error(event.text ?? 'Speech error'))
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
 this.logService.trace('[Speech] Extension cancelling consumer session', sessionId);
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
```

### Dispose method update

```typescript
dispose(): void {
 // existing disposal...

 this.hasSpeechProviderListener.dispose();

 for (const session of this.consumerSpeechToTextSessions.values()) {
  session.disposables.dispose();
 }
 this.consumerSpeechToTextSessions.clear();
}
```

---

## 3. ExtHostSpeech Consumer Implementation

### New imports

```typescript
import { AsyncIterableSource } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { transformErrorFromSerialization } from '../../../base/common/errors.js';
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';
import type { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
```

### New type

```typescript
type ConsumerSpeechToTextSession = {
 readonly stream: AsyncIterableSource<vscode.SpeechToTextEvent>;
 readonly cts: CancellationTokenSource;
};
```

### New class members

```typescript
// Consumer session tracking
private readonly consumerSessions = new Map<number, ConsumerSpeechToTextSession>();
private readonly _onDidChangeSpeechProvider = new Emitter<void>();
readonly onDidChangeSpeechProvider: Event<void> = this._onDidChangeSpeechProvider.event;
private _hasSpeechProvider: boolean = false;
```

### Constructor addition

```typescript
// After setting this.proxy
this.proxy.$hasSpeechProvider().then(available => {
 this._hasSpeechProvider = available;
});
```

### New methods

```typescript
get hasSpeechProvider(): boolean {
 return this._hasSpeechProvider;
}

async createSpeechToTextSession(
 extension: IExtensionDescription,
 options?: vscode.SpeechToTextOptions
): Promise<vscode.SpeechToTextSession> {
 checkProposedApiEnabled(extension, 'speechConsumer');

 const sessionId = ExtHostSpeech.ID_POOL++;
 const stream = new AsyncIterableSource<vscode.SpeechToTextEvent>();
 const cts = new CancellationTokenSource();

 this.consumerSessions.set(sessionId, { stream, cts });

 try {
  await this.proxy.$createConsumerSpeechToTextSession(sessionId, {
   language: options?.language,
   context: 'extension'
  });
 } catch (error) {
  this.consumerSessions.delete(sessionId);
  throw error;
 }

 return {
  events: stream.asyncIterable,
  dispose: () => {
   cts.dispose(true);
   this.proxy.$cancelConsumerSpeechToTextSession(sessionId);
   this.consumerSessions.delete(sessionId);
  }
 };
}

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
```

---

## 4. API Namespace (`extHost.api.impl.ts`)

### Updated speech namespace

```typescript
const speech: typeof vscode.speech = {
 registerSpeechProvider(id, provider) {
  return extHostSpeech.registerProvider(extension.identifier, id, provider);
 },
 get hasSpeechProvider(): boolean {
  return extHostSpeech.hasSpeechProvider;
 },
 get onDidChangeSpeechProvider(): vscode.Event<void> {
  return extHostSpeech.onDidChangeSpeechProvider;
 },
 createSpeechToTextSession(options?: vscode.SpeechToTextOptions): Thenable<vscode.SpeechToTextSession> {
  checkProposedApiEnabled(extension, 'speechConsumer');
  return extHostSpeech.createSpeechToTextSession(extension, options);
 }
};
```

---

## 5. Proposed API Types (`vscode.proposed.speechConsumer.d.ts`)

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

 export interface SpeechToTextSession {
  readonly events: AsyncIterable<SpeechToTextEvent>;
  dispose(): void;
 }

 export namespace speech {
  export const hasSpeechProvider: boolean;
  export const onDidChangeSpeechProvider: Event<void>;
  export function createSpeechToTextSession(options?: SpeechToTextOptions): Thenable<SpeechToTextSession>;
 }
}
```

---

## 6. Proposal Registration (`extensionsApiProposals.ts`)

```typescript
speechConsumer: {
 proposal: 'https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.speechConsumer.d.ts',
 version: 1
},
```

---

## 7. Test Extension package.json

```json
{
  "name": "speech-consumer-test",
  "displayName": "Speech Consumer Test",
  "version": "0.0.1",
  "engines": {
    "vscode": "^1.96.0"
  },
  "enabledApiProposals": [
    "speechConsumer"
  ],
  "activationEvents": [
    "onCommand:speechTest.start"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "speechTest.start",
        "title": "Start Speech Recognition"
      }
    ]
  }
}
```

---

## 8. Test Extension Code

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
 const cmd = vscode.commands.registerCommand('speechTest.start', async () => {
  if (!vscode.speech.hasSpeechProvider) {
   vscode.window.showErrorMessage('No speech provider');
   return;
  }

  const session = await vscode.speech.createSpeechToTextSession();
  context.subscriptions.push({ dispose: () => session.dispose() });

  try {
   for await (const event of session.events) {
    if (event.status === vscode.SpeechToTextStatus.Recognized) {
     vscode.window.showInformationMessage(`Recognized: ${event.text}`);
    }
   }
  } catch (err) {
   vscode.window.showErrorMessage(`Error: ${err}`);
  }
 });

 context.subscriptions.push(cmd);
}
```

---

## Quick Reference: File Locations

| Component | File Path |
|-----------|-----------|
| Protocol | `src/vs/workbench/api/common/extHost.protocol.ts` |
| MainThread | `src/vs/workbench/api/browser/mainThreadSpeech.ts` |
| ExtHost | `src/vs/workbench/api/common/extHostSpeech.ts` |
| API Factory | `src/vs/workbench/api/common/extHost.api.impl.ts` |
| Proposed Types | `src/vscode-dts/vscode.proposed.speechConsumer.d.ts` |
| Proposals Registry | `src/vs/workbench/services/extensions/common/extensionsApiProposals.ts` |
| Speech Service | `src/vs/workbench/contrib/speech/common/speechService.ts` |
| Speech Service Impl | `src/vs/workbench/contrib/speech/browser/speechService.ts` |
| AsyncIterableSource | `src/vs/base/common/async.ts` (line ~2203) |

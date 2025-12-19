/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { AsyncIterableSource } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { SerializedError, transformErrorFromSerialization } from '../../../base/common/errors.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostSpeechShape, IMainContext, ISpeechToTextConsumerOptions, MainContext, MainThreadSpeechShape } from './extHost.protocol.js';
import type * as vscode from 'vscode';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';
import { ISpeechToTextEvent } from '../../contrib/speech/common/speechService.js';

// Consumer Session Type
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

	// Consumer-side tracking
	private readonly consumerSessions = new Map<number, ConsumerSpeechToTextSession>();
	private readonly _onDidChangeSpeechProvider = new Emitter<void>();
	readonly onDidChangeSpeechProvider: Event<void> = this._onDidChangeSpeechProvider.event;
	private _hasSpeechProvider: boolean = false;

	constructor(
		mainContext: IMainContext
	) {
		this.proxy = mainContext.getProxy(MainContext.MainThreadSpeech);

		// Initialize provider availability
		this.proxy.$hasSpeechProvider().then(available => {
			this._hasSpeechProvider = available;
		});
	}

	// Consumer API

	get hasSpeechProvider(): boolean {
		return this._hasSpeechProvider;
	}

	/**
	 * Starts a speech-to-text session that extensions can consume.
	 * Returns an AsyncIterable that streams SpeechToTextEvent objects.
	 */
	async startSpeechToTextSession(
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

	// ExtHost callbacks for consumer sessions

	$onConsumerSpeechToTextEvent(sessionId: number, event: ISpeechToTextEvent): void {
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

	// Existing Provider Implementation

	async $createSpeechToTextSession(handle: number, session: number, language?: string): Promise<void> {
		const provider = this.providers.get(handle);
		if (!provider) {
			return;
		}

		const disposables = new DisposableStore();

		const cts = new CancellationTokenSource();
		this.sessions.set(session, cts);

		const speechToTextSession = await provider.provideSpeechToTextSession(cts.token, language ? { language } : undefined);
		if (!speechToTextSession) {
			return;
		}

		disposables.add(speechToTextSession.onDidChange(e => {
			if (cts.token.isCancellationRequested) {
				return;
			}

			this.proxy.$emitSpeechToTextEvent(session, e);
		}));

		disposables.add(cts.token.onCancellationRequested(() => disposables.dispose()));
	}

	async $cancelSpeechToTextSession(session: number): Promise<void> {
		this.sessions.get(session)?.dispose(true);
		this.sessions.delete(session);
	}

	async $createTextToSpeechSession(handle: number, session: number, language?: string): Promise<void> {
		const provider = this.providers.get(handle);
		if (!provider) {
			return;
		}

		const disposables = new DisposableStore();

		const cts = new CancellationTokenSource();
		this.sessions.set(session, cts);

		const textToSpeech = await provider.provideTextToSpeechSession(cts.token, language ? { language } : undefined);
		if (!textToSpeech) {
			return;
		}

		this.synthesizers.set(session, textToSpeech);

		disposables.add(textToSpeech.onDidChange(e => {
			if (cts.token.isCancellationRequested) {
				return;
			}

			this.proxy.$emitTextToSpeechEvent(session, e);
		}));

		disposables.add(cts.token.onCancellationRequested(() => disposables.dispose()));
	}

	async $synthesizeSpeech(session: number, text: string): Promise<void> {
		this.synthesizers.get(session)?.synthesize(text);
	}

	async $cancelTextToSpeechSession(session: number): Promise<void> {
		this.sessions.get(session)?.dispose(true);
		this.sessions.delete(session);
		this.synthesizers.delete(session);
	}

	async $createKeywordRecognitionSession(handle: number, session: number): Promise<void> {
		const provider = this.providers.get(handle);
		if (!provider) {
			return;
		}

		const disposables = new DisposableStore();

		const cts = new CancellationTokenSource();
		this.sessions.set(session, cts);

		const keywordRecognitionSession = await provider.provideKeywordRecognitionSession(cts.token);
		if (!keywordRecognitionSession) {
			return;
		}

		disposables.add(keywordRecognitionSession.onDidChange(e => {
			if (cts.token.isCancellationRequested) {
				return;
			}

			this.proxy.$emitKeywordRecognitionEvent(session, e);
		}));

		disposables.add(cts.token.onCancellationRequested(() => disposables.dispose()));
	}

	async $cancelKeywordRecognitionSession(session: number): Promise<void> {
		this.sessions.get(session)?.dispose(true);
		this.sessions.delete(session);
	}

	registerProvider(extension: ExtensionIdentifier, identifier: string, provider: vscode.SpeechProvider): IDisposable {
		const handle = ExtHostSpeech.ID_POOL++;

		this.providers.set(handle, provider);
		this.proxy.$registerProvider(handle, identifier, { extension, displayName: extension.value });

		return toDisposable(() => {
			this.proxy.$unregisterProvider(handle);
			this.providers.delete(handle);
		});
	}
}

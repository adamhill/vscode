/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostSpeechShape, IMainContext, MainContext, MainThreadSpeechShape } from './extHost.protocol.js';
import type * as vscode from 'vscode';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { AsyncIterableSource } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { transformErrorFromSerialization, SerializedError } from '../../../base/common/errors.js';
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';

type ConsumerSpeechToTextSession = {
	readonly stream: AsyncIterableSource<vscode.SpeechToTextEvent>;
	readonly cts: CancellationTokenSource;
};

export class ExtHostSpeech implements ExtHostSpeechShape {

	private static ID_POOL = 1;

	private readonly proxy: MainThreadSpeechShape;

	private readonly providers = new Map<number, vscode.SpeechProvider>();
	private readonly sessions = new Map<number, CancellationTokenSource>();
	private readonly synthesizers = new Map<number, vscode.TextToSpeechSession>();

	// Consumer session tracking
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

	// #region Consumer API

	/**
	 * Returns true if a speech provider is available.
	 */
	get hasSpeechProvider(): boolean {
		return this._hasSpeechProvider;
	}

	/**
	 * Creates a speech-to-text session for extensions to consume speech recognition.
	 * @param extension The extension requesting the session
	 * @param options Optional configuration for the session
	 * @returns A session object with an events stream and dispose method
	 */
	async createSpeechToTextSession(
		extension: IExtensionDescription,
		options?: vscode.SpeechToTextOptions
	): Promise<{ events: AsyncIterable<vscode.SpeechToTextEvent>; dispose(): void }> {
		checkProposedApiEnabled(extension, 'speech');

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

	/**
	 * Creates a speech-to-text session synchronously for extensions to consume speech recognition.
	 * The RPC call to create the session happens in the background.
	 * @param extension The extension requesting the session
	 * @param options Optional configuration for the session
	 * @returns A session object with an events stream and dispose method
	 */
	createSpeechToTextSessionSync(
		extension: IExtensionDescription,
		options?: vscode.SpeechToTextOptions
	): { events: AsyncIterable<vscode.SpeechToTextEvent>; dispose(): void } {
		checkProposedApiEnabled(extension, 'speech');

		const sessionId = ExtHostSpeech.ID_POOL++;
		const stream = new AsyncIterableSource<vscode.SpeechToTextEvent>();
		const cts = new CancellationTokenSource();

		this.consumerSessions.set(sessionId, { stream, cts });

		// Fire and forget - create session in background
		this.proxy.$createConsumerSpeechToTextSession(sessionId, {
			language: options?.language,
			context: 'extension'
		}).catch(error => {
			// If creation fails, reject the stream
			this.consumerSessions.delete(sessionId);
			stream.reject(error);
		});

		return {
			events: stream.asyncIterable,
			dispose: () => {
				cts.dispose(true);
				this.proxy.$cancelConsumerSpeechToTextSession(sessionId);
				this.consumerSessions.delete(sessionId);
			}
		};
	}

	/**
	 * Called by MainThread when a speech-to-text event occurs for a consumer session.
	 * @param sessionId The session identifier
	 * @param event The speech event to emit
	 */
	$onConsumerSpeechToTextEvent(sessionId: number, event: vscode.SpeechToTextEvent): void {
		const session = this.consumerSessions.get(sessionId);
		if (session && !session.cts.token.isCancellationRequested) {
			session.stream.emitOne(event);
		}
	}

	/**
	 * Called by MainThread when a consumer session ends.
	 * @param sessionId The session identifier
	 * @param error Optional error if the session ended with an error
	 */
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

	/**
	 * Called by MainThread when speech provider availability changes.
	 * @param available Whether a speech provider is now available
	 */
	$onDidChangeSpeechProviderAvailability(available: boolean): void {
		this._hasSpeechProvider = available;
		this._onDidChangeSpeechProvider.fire();
	}

	// #endregion
}

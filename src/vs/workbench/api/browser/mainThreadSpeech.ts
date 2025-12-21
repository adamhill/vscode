/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { transformErrorForSerialization } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ExtHostContext, ExtHostSpeechShape, ISpeechToTextConsumerOptions, MainContext, MainThreadSpeechShape } from '../common/extHost.protocol.js';
import { IKeywordRecognitionEvent, ISpeechProviderMetadata, ISpeechService, ISpeechToTextEvent, ITextToSpeechEvent, SpeechToTextStatus, TextToSpeechStatus } from '../../contrib/speech/common/speechService.js';
import { IExtHostContext, extHostNamedCustomer } from '../../services/extensions/common/extHostCustomers.js';

type SpeechToTextSession = {
	readonly onDidChange: Emitter<ISpeechToTextEvent>;
};

type TextToSpeechSession = {
	readonly onDidChange: Emitter<ITextToSpeechEvent>;
};

type KeywordRecognitionSession = {
	readonly onDidChange: Emitter<IKeywordRecognitionEvent>;
};

type ConsumerSpeechToTextSession = {
	readonly cts: CancellationTokenSource;
	readonly disposables: DisposableStore;
};

@extHostNamedCustomer(MainContext.MainThreadSpeech)
export class MainThreadSpeech implements MainThreadSpeechShape {

	private readonly proxy: ExtHostSpeechShape;

	private readonly providerRegistrations = new Map<number, IDisposable>();

	private readonly speechToTextSessions = new Map<number, SpeechToTextSession>();
	private readonly textToSpeechSessions = new Map<number, TextToSpeechSession>();
	private readonly keywordRecognitionSessions = new Map<number, KeywordRecognitionSession>();

	private readonly consumerSpeechToTextSessions = new Map<number, ConsumerSpeechToTextSession>();
	private readonly hasSpeechProviderListener: IDisposable;

	constructor(
		extHostContext: IExtHostContext,
		@ISpeechService private readonly speechService: ISpeechService,
		@ILogService private readonly logService: ILogService
	) {
		this.proxy = extHostContext.getProxy(ExtHostContext.ExtHostSpeech);

		this.hasSpeechProviderListener = this.speechService.onDidChangeHasSpeechProvider(() => {
			this.proxy.$onDidChangeSpeechProviderAvailability(this.speechService.hasSpeechProvider);
		});
	}

	$registerProvider(handle: number, identifier: string, metadata: ISpeechProviderMetadata): void {
		this.logService.trace('[Speech] extension registered provider', metadata.extension.value);

		const registration = this.speechService.registerSpeechProvider(identifier, {
			metadata,
			createSpeechToTextSession: (token, options) => {
				if (token.isCancellationRequested) {
					return {
						onDidChange: Event.None
					};
				}

				const disposables = new DisposableStore();
				const session = Math.random();

				this.proxy.$createSpeechToTextSession(handle, session, options?.language);

				const onDidChange = disposables.add(new Emitter<ISpeechToTextEvent>());
				this.speechToTextSessions.set(session, { onDidChange });

				disposables.add(token.onCancellationRequested(() => {
					this.proxy.$cancelSpeechToTextSession(session);
					this.speechToTextSessions.delete(session);
					disposables.dispose();
				}));

				return {
					onDidChange: onDidChange.event
				};
			},
			createTextToSpeechSession: (token, options) => {
				if (token.isCancellationRequested) {
					return {
						onDidChange: Event.None,
						synthesize: async () => { }
					};
				}

				const disposables = new DisposableStore();
				const session = Math.random();

				this.proxy.$createTextToSpeechSession(handle, session, options?.language);

				const onDidChange = disposables.add(new Emitter<ITextToSpeechEvent>());
				this.textToSpeechSessions.set(session, { onDidChange });

				disposables.add(token.onCancellationRequested(() => {
					this.proxy.$cancelTextToSpeechSession(session);
					this.textToSpeechSessions.delete(session);
					disposables.dispose();
				}));

				return {
					onDidChange: onDidChange.event,
					synthesize: async text => {
						await this.proxy.$synthesizeSpeech(session, text);
						const disposable = new DisposableStore();
						try {
							await raceCancellation(Event.toPromise(Event.filter(onDidChange.event, e => e.status === TextToSpeechStatus.Stopped, disposable), disposable), token);
						} finally {
							disposable.dispose();
						}
					}
				};
			},
			createKeywordRecognitionSession: token => {
				if (token.isCancellationRequested) {
					return {
						onDidChange: Event.None
					};
				}

				const disposables = new DisposableStore();
				const session = Math.random();

				this.proxy.$createKeywordRecognitionSession(handle, session);

				const onDidChange = disposables.add(new Emitter<IKeywordRecognitionEvent>());
				this.keywordRecognitionSessions.set(session, { onDidChange });

				disposables.add(token.onCancellationRequested(() => {
					this.proxy.$cancelKeywordRecognitionSession(session);
					this.keywordRecognitionSessions.delete(session);
					disposables.dispose();
				}));

				return {
					onDidChange: onDidChange.event
				};
			}
		});
		this.providerRegistrations.set(handle, {
			dispose: () => {
				registration.dispose();
			}
		});
	}

	$unregisterProvider(handle: number): void {
		const registration = this.providerRegistrations.get(handle);
		if (registration) {
			registration.dispose();
			this.providerRegistrations.delete(handle);
		}
	}

	$emitSpeechToTextEvent(session: number, event: ISpeechToTextEvent): void {
		const providerSession = this.speechToTextSessions.get(session);
		providerSession?.onDidChange.fire(event);
	}

	$emitTextToSpeechEvent(session: number, event: ITextToSpeechEvent): void {
		const providerSession = this.textToSpeechSessions.get(session);
		providerSession?.onDidChange.fire(event);
	}

	$emitKeywordRecognitionEvent(session: number, event: IKeywordRecognitionEvent): void {
		const providerSession = this.keywordRecognitionSessions.get(session);
		providerSession?.onDidChange.fire(event);
	}

	/**
	 * Creates a consumer speech-to-text session for an extension to consume internal speech services
	 */
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

	/**
	 * Cancels an active consumer speech-to-text session
	 */
	async $cancelConsumerSpeechToTextSession(sessionId: number): Promise<void> {
		this.logService.trace('[Speech] Extension cancelling consumer session', sessionId);
		this.cleanupConsumerSession(sessionId);
	}

	/**
	 * Checks if a speech provider is currently available
	 */
	async $hasSpeechProvider(): Promise<boolean> {
		return this.speechService.hasSpeechProvider;
	}

	/**
	 * Cleans up a consumer session by disposing its resources
	 */
	private cleanupConsumerSession(sessionId: number): void {
		const session = this.consumerSpeechToTextSessions.get(sessionId);
		if (session) {
			session.disposables.dispose();
			this.consumerSpeechToTextSessions.delete(sessionId);
		}
	}

	dispose(): void {
		this.providerRegistrations.forEach(disposable => disposable.dispose());
		this.providerRegistrations.clear();

		this.speechToTextSessions.forEach(session => session.onDidChange.dispose());
		this.speechToTextSessions.clear();

		this.textToSpeechSessions.forEach(session => session.onDidChange.dispose());
		this.textToSpeechSessions.clear();

		this.keywordRecognitionSessions.forEach(session => session.onDidChange.dispose());
		this.keywordRecognitionSessions.clear();

		this.hasSpeechProviderListener.dispose();

		for (const session of this.consumerSpeechToTextSessions.values()) {
			session.disposables.dispose();
		}
		this.consumerSpeechToTextSessions.clear();
	}
}

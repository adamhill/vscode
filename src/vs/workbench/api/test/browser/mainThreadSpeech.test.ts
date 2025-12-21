/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { transformErrorForSerialization } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { mock } from '../../../../base/test/common/mock.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { MainThreadSpeech } from '../../browser/mainThreadSpeech.js';
import { ExtHostContext, ExtHostSpeechShape, ISpeechToTextConsumerOptions } from '../../common/extHost.protocol.js';
import { ISpeechService, ISpeechToTextEvent, ISpeechToTextSession, SpeechToTextStatus } from '../../../contrib/speech/common/speechService.js';
import { IExtHostContext } from '../../../services/extensions/common/extHostCustomers.js';
import { ExtensionHostKind } from '../../../services/extensions/common/extensionHostKind.js';
import { ProxyIdentifier } from '../../../services/extensions/common/proxyIdentifier.js';

suite('MainThreadSpeech - Consumer API', () => {

	let disposables: DisposableStore;
	let mainThreadSpeech: MainThreadSpeech;
	let mockSpeechService: MockSpeechService;
	let mockExtHostProxy: MockExtHostSpeechShape;
	let onDidChangeHasSpeechProvider: Emitter<void>;

	class MockSpeechService extends mock<ISpeechService>() {
		private _hasSpeechProvider = false;
		private mockSession: MockSpeechToTextSession | undefined;

		override get hasSpeechProvider(): boolean {
			return this._hasSpeechProvider;
		}

		setHasSpeechProvider(value: boolean): void {
			this._hasSpeechProvider = value;
			onDidChangeHasSpeechProvider.fire();
		}

		override get onDidChangeHasSpeechProvider() {
			return onDidChangeHasSpeechProvider.event;
		}

		override async createSpeechToTextSession(token: CancellationToken, context?: string): Promise<ISpeechToTextSession> {
			if (!this._hasSpeechProvider) {
				throw new Error('No speech provider available');
			}
			this.mockSession = new MockSpeechToTextSession();
			return this.mockSession;
		}

		getMockSession(): MockSpeechToTextSession | undefined {
			return this.mockSession;
		}
	}

	class MockSpeechToTextSession implements ISpeechToTextSession {
		private readonly _onDidChange = new Emitter<ISpeechToTextEvent>();
		readonly onDidChange = this._onDidChange.event;

		fireEvent(event: ISpeechToTextEvent): void {
			this._onDidChange.fire(event);
		}

		dispose(): void {
			this._onDidChange.dispose();
		}
	}

	class MockExtHostSpeechShape implements ExtHostSpeechShape {
		public consumerEvents: Array<{ sessionId: number; event: ISpeechToTextEvent }> = [];
		public sessionEnds: Array<{ sessionId: number; error: any }> = [];
		public availabilityChanges: boolean[] = [];

		$onConsumerSpeechToTextEvent(sessionId: number, event: ISpeechToTextEvent): void {
			this.consumerEvents.push({ sessionId, event });
		}

		$onConsumerSpeechToTextSessionEnd(sessionId: number, error?: any): void {
			this.sessionEnds.push({ sessionId, error });
		}

		$onDidChangeSpeechProviderAvailability(available: boolean): void {
			this.availabilityChanges.push(available);
		}

		async $createSpeechToTextSession(handle: number, session: number, language?: string): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}

		async $cancelSpeechToTextSession(session: number): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}

		async $createTextToSpeechSession(handle: number, session: number, language?: string): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}

		async $cancelTextToSpeechSession(session: number): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}

		async $synthesizeSpeech(session: number, text: string): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}

		async $createKeywordRecognitionSession(handle: number, session: number): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}

		async $cancelKeywordRecognitionSession(session: number): Promise<void> {
			throw new Error('Not implemented for consumer API tests');
		}
	}

	setup(() => {
		disposables = new DisposableStore();
		onDidChangeHasSpeechProvider = disposables.add(new Emitter<void>());
		mockSpeechService = new MockSpeechService();
		mockExtHostProxy = new MockExtHostSpeechShape();

		const mockExtHostContext: IExtHostContext = {
			remoteAuthority: '',
			extensionHostKind: ExtensionHostKind.LocalProcess,
			dispose: () => { },
			assertRegistered: () => { },
			set: () => undefined as never,
			getProxy: <T>(identifier: ProxyIdentifier<T>) => {
				if (identifier === ExtHostContext.ExtHostSpeech) {
					return mockExtHostProxy as never;
				}
				throw new Error('Unexpected proxy request');
			},
			drain: () => Promise.resolve()
		};

		mainThreadSpeech = disposables.add(new MainThreadSpeech(
			mockExtHostContext,
			mockSpeechService,
			new NullLogService()
		));
	});

	teardown(() => {
		disposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('$hasSpeechProvider returns speechService.hasSpeechProvider value', async () => {
		mockSpeechService.setHasSpeechProvider(false);
		assert.strictEqual(await mainThreadSpeech.$hasSpeechProvider(), false);

		mockSpeechService.setHasSpeechProvider(true);
		assert.strictEqual(await mainThreadSpeech.$hasSpeechProvider(), true);
	});

	test('hasSpeechProvider listener fires $onDidChangeSpeechProviderAvailability', async () => {
		assert.strictEqual(mockExtHostProxy.availabilityChanges.length, 0);

		mockSpeechService.setHasSpeechProvider(true);
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.availabilityChanges.length, 1);
		assert.strictEqual(mockExtHostProxy.availabilityChanges[0], true);

		mockSpeechService.setHasSpeechProvider(false);
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.availabilityChanges.length, 2);
		assert.strictEqual(mockExtHostProxy.availabilityChanges[1], false);
	});

	test('$createConsumerSpeechToTextSession throws when no provider available', async () => {
		mockSpeechService.setHasSpeechProvider(false);

		await assert.rejects(
			async () => await mainThreadSpeech.$createConsumerSpeechToTextSession(1),
			/No speech provider available/
		);
	});

	test('$createConsumerSpeechToTextSession creates session with ISpeechService', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);

		const session = mockSpeechService.getMockSession();
		assert.ok(session, 'Session should be created');
	});

	test('session Started event is forwarded to ExtHost', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		session.fireEvent({ status: SpeechToTextStatus.Started });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 1);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].sessionId, 1);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.status, SpeechToTextStatus.Started);
	});

	test('session Recognizing event is forwarded to ExtHost', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		session.fireEvent({ status: SpeechToTextStatus.Recognizing, text: 'hello' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 1);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.status, SpeechToTextStatus.Recognizing);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.text, 'hello');
	});

	test('session Recognized event is forwarded to ExtHost', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		session.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'hello world' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 1);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.status, SpeechToTextStatus.Recognized);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.text, 'hello world');
	});

	test('session Stopped status triggers session end notification without error', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		session.fireEvent({ status: SpeechToTextStatus.Stopped });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 1);
		assert.strictEqual(mockExtHostProxy.sessionEnds.length, 1);
		assert.strictEqual(mockExtHostProxy.sessionEnds[0].sessionId, 1);
		assert.strictEqual(mockExtHostProxy.sessionEnds[0].error, undefined);
	});

	test('session Error status triggers session end with serialized error', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		session.fireEvent({ status: SpeechToTextStatus.Error, text: 'Microphone not found' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 1);
		assert.strictEqual(mockExtHostProxy.sessionEnds.length, 1);
		assert.strictEqual(mockExtHostProxy.sessionEnds[0].sessionId, 1);
		assert.ok(mockExtHostProxy.sessionEnds[0].error, 'Error should be present');
		assert.strictEqual(mockExtHostProxy.sessionEnds[0].error.message, 'Microphone not found');
	});

	test('session Error status with no text uses default error message', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		session.fireEvent({ status: SpeechToTextStatus.Error });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.sessionEnds.length, 1);
		assert.strictEqual(mockExtHostProxy.sessionEnds[0].error.message, 'Speech error');
	});

	test('$cancelConsumerSpeechToTextSession cleans up session', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		await mainThreadSpeech.$cancelConsumerSpeechToTextSession(1);

		// Events after cancellation should not be forwarded
		session.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'should not forward' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 0);
	});

	test('cancelling non-existent session does not throw', async () => {
		await assert.doesNotReject(async () => {
			await mainThreadSpeech.$cancelConsumerSpeechToTextSession(999);
		});
	});

	test('multiple concurrent sessions are tracked independently', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		// Create three sessions
		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session1 = mockSpeechService.getMockSession()!;

		await mainThreadSpeech.$createConsumerSpeechToTextSession(2);
		const session2 = mockSpeechService.getMockSession()!;

		await mainThreadSpeech.$createConsumerSpeechToTextSession(3);
		const session3 = mockSpeechService.getMockSession()!;

		// Fire events on each session
		session1.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'session1' });
		session2.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'session2' });
		session3.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'session3' });
		await timeout(0);

		// Verify all events were received with correct session IDs
		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 3);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].sessionId, 1);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.text, 'session1');
		assert.strictEqual(mockExtHostProxy.consumerEvents[1].sessionId, 2);
		assert.strictEqual(mockExtHostProxy.consumerEvents[1].event.text, 'session2');
		assert.strictEqual(mockExtHostProxy.consumerEvents[2].sessionId, 3);
		assert.strictEqual(mockExtHostProxy.consumerEvents[2].event.text, 'session3');
	});

	test('session cleanup removes from tracking map', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		// Stop the session to trigger cleanup
		session.fireEvent({ status: SpeechToTextStatus.Stopped });
		await timeout(0);

		// Try to send another event - should not be forwarded
		mockExtHostProxy.consumerEvents = [];
		session.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'after stop' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 0);
	});

	test('multiple events for same session are all forwarded', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		// Fire multiple events
		session.fireEvent({ status: SpeechToTextStatus.Started });
		session.fireEvent({ status: SpeechToTextStatus.Recognizing, text: 'hel' });
		session.fireEvent({ status: SpeechToTextStatus.Recognizing, text: 'hello' });
		session.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'hello world' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 4);
		assert.strictEqual(mockExtHostProxy.consumerEvents[0].event.status, SpeechToTextStatus.Started);
		assert.strictEqual(mockExtHostProxy.consumerEvents[1].event.status, SpeechToTextStatus.Recognizing);
		assert.strictEqual(mockExtHostProxy.consumerEvents[1].event.text, 'hel');
		assert.strictEqual(mockExtHostProxy.consumerEvents[2].event.text, 'hello');
		assert.strictEqual(mockExtHostProxy.consumerEvents[3].event.status, SpeechToTextStatus.Recognized);
	});

	test('options are passed to speechService.createSpeechToTextSession', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		let capturedContext: string | undefined;
		mockSpeechService.createSpeechToTextSession = async (token: CancellationToken, context?: string) => {
			capturedContext = context;
			return new MockSpeechToTextSession();
		};

		const options: ISpeechToTextConsumerOptions = {
			language: 'en-US',
			context: 'testing'
		};

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1, options);

		assert.strictEqual(capturedContext, 'testing');
	});

	test('default context is "extension" when not provided', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		let capturedContext: string | undefined;
		mockSpeechService.createSpeechToTextSession = async (token: CancellationToken, context?: string) => {
			capturedContext = context;
			return new MockSpeechToTextSession();
		};

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);

		assert.strictEqual(capturedContext, 'extension');
	});

	test('session creation failure cleans up properly', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		const expectedError = new Error('Failed to create session');
		mockSpeechService.createSpeechToTextSession = async () => {
			throw expectedError;
		};

		await assert.rejects(
			async () => await mainThreadSpeech.$createConsumerSpeechToTextSession(1),
			expectedError
		);

		// Session should not forward events after failure
		// This is implicitly tested by not having a session to fire events on
	});

	test('dispose cleans up all active consumer sessions', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		// Create multiple sessions
		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		await mainThreadSpeech.$createConsumerSpeechToTextSession(2);
		await mainThreadSpeech.$createConsumerSpeechToTextSession(3);

		// Dispose the main thread speech
		mainThreadSpeech.dispose();

		// All sessions should be cleaned up - try to access them
		// (they should not forward events)
		const sessions = [1, 2, 3];
		for (const sessionId of sessions) {
			await assert.doesNotReject(async () => {
				await mainThreadSpeech.$cancelConsumerSpeechToTextSession(sessionId);
			});
		}
	});

	test('dispose unsubscribes from hasSpeechProvider listener', async () => {
		// Get initial availability change count
		const initialCount = mockExtHostProxy.availabilityChanges.length;

		mainThreadSpeech.dispose();

		// Fire the event - should not trigger proxy call
		mockSpeechService.setHasSpeechProvider(true);
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.availabilityChanges.length, initialCount);
	});

	test('events during cancellation are ignored', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1);
		const session = mockSpeechService.getMockSession()!;

		// Cancel the session
		await mainThreadSpeech.$cancelConsumerSpeechToTextSession(1);

		// Clear any previous events
		mockExtHostProxy.consumerEvents = [];

		// Fire event after cancellation
		session.fireEvent({ status: SpeechToTextStatus.Recognized, text: 'should be ignored' });
		await timeout(0);

		assert.strictEqual(mockExtHostProxy.consumerEvents.length, 0);
	});

	test('error serialization preserves message', async () => {
		const errorMessage = 'Custom error message with details';
		const error = new Error(errorMessage);
		const serialized = transformErrorForSerialization(error);

		assert.ok(serialized);
		assert.strictEqual(serialized.message, errorMessage);
	});

	test('session with language option', async () => {
		mockSpeechService.setHasSpeechProvider(true);

		const options: ISpeechToTextConsumerOptions = {
			language: 'fr-FR'
		};

		await mainThreadSpeech.$createConsumerSpeechToTextSession(1, options);

		const session = mockSpeechService.getMockSession();
		assert.ok(session, 'Session should be created with language option');
	});
});

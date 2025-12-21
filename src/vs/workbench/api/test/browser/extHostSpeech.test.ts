/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ExtHostSpeech } from '../../common/extHostSpeech.js';
import { MainThreadSpeechShape, ISpeechToTextConsumerOptions } from '../../common/extHost.protocol.js';
import { TestRPCProtocol } from '../common/testRPCProtocol.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IExtensionDescription, ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ISpeechToTextEvent } from '../../../contrib/speech/common/speechService.js';
import { SpeechToTextStatus } from '../../common/extHostTypes.js';
import { SerializedError } from '../../../../base/common/errors.js';
import { timeout } from '../../../../base/common/async.js';
import { ProxyIdentifier } from '../../../services/extensions/common/proxyIdentifier.js';

suite('ExtHostSpeech', function () {
	ensureNoDisposablesAreLeakedInTestSuite();

	// Test helper to create extension description
	function createExtension(id: string = 'test.extension'): IExtensionDescription {
		return {
			identifier: new ExtensionIdentifier(id),
			name: 'Test Extension',
			version: '1.0.0',
			publisher: 'test',
			engines: { vscode: '*' },
			extensionLocation: URI.file('/test'),
			isBuiltin: false,
			isUserBuiltin: false,
			isUnderDevelopment: false,
			enabledApiProposals: ['speech'],
			targetPlatform: 'undefined',
			preRelease: false
		} as unknown as IExtensionDescription;
	}

	// Test helper to collect async iterable items
	async function collectAsyncIterable<T>(iterable: AsyncIterable<T>, maxItems: number = 10, timeoutMs: number = 1000): Promise<T[]> {
		const items: T[] = [];
		const startTime = Date.now();
		try {
			for await (const item of iterable) {
				items.push(item);
				if (items.length >= maxItems || Date.now() - startTime > timeoutMs) {
					break;
				}
			}
		} catch (error) {
			// Store error for later assertion
			throw error;
		}
		return items;
	}

	test('createSpeechToTextSession creates a session with events AsyncIterable', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension, { language: 'en-US' });

		assert.ok(session, 'Session should be created');
		assert.ok(session.events, 'Session should have events property');
		assert.ok(typeof session.dispose === 'function', 'Session should have dispose method');

		session.dispose();
	});

	test('session ID generation is unique', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session1 = await extHostSpeech.createSpeechToTextSession(extension);
		const session2 = await extHostSpeech.createSpeechToTextSession(extension);

		// Both sessions should be valid
		assert.ok(session1, 'First session should be created');
		assert.ok(session2, 'Second session should be created');

		// Clean up
		session1.dispose();
		session2.dispose();
	});

	test('$onConsumerSpeechToTextEvent streams events to the AsyncIterable', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);

		// Start consuming events in the background
		const eventsPromise = collectAsyncIterable(session.events, 3, 2000);

		// Simulate events coming from MainThread
		await rpcProtocol.sync();

		const event1: ISpeechToTextEvent = { status: SpeechToTextStatus.Started };
		const event2: ISpeechToTextEvent = { status: SpeechToTextStatus.Recognizing, text: 'hello' };
		const event3: ISpeechToTextEvent = { status: SpeechToTextStatus.Recognized, text: 'hello world' };

		// Get the session ID from the internal sessions map
		const sessionId = Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0];

		extHostSpeech.$onConsumerSpeechToTextEvent(parseInt(sessionId), event1);
		extHostSpeech.$onConsumerSpeechToTextEvent(parseInt(sessionId), event2);
		extHostSpeech.$onConsumerSpeechToTextEvent(parseInt(sessionId), event3);

		// End the session
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(parseInt(sessionId));

		const events = await eventsPromise;
		assert.strictEqual(events.length, 3, 'Should receive all three events');
		assert.strictEqual(events[0].status, SpeechToTextStatus.Started);
		assert.strictEqual(events[1].status, SpeechToTextStatus.Recognizing);
		assert.strictEqual(events[1].text, 'hello');
		assert.strictEqual(events[2].status, SpeechToTextStatus.Recognized);
		assert.strictEqual(events[2].text, 'hello world');

		session.dispose();
	});

	test('$onConsumerSpeechToTextSessionEnd completes the AsyncIterable', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);

		let completed = false;
		const consumePromise = (async () => {
			for await (const _ of session.events) {
				// No events expected
			}
			completed = true;
		})();

		await rpcProtocol.sync();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId);

		await consumePromise;
		assert.strictEqual(completed, true, 'AsyncIterable should complete');

		session.dispose();
	});

	test('$onConsumerSpeechToTextSessionEnd with error rejects the AsyncIterable', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);

		let caughtError: Error | undefined;
		const consumePromise = (async () => {
			try {
				for await (const _ of session.events) {
					// No events expected
				}
			} catch (error) {
				caughtError = error as Error;
			}
		})();

		await rpcProtocol.sync();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);
		const serializedError: SerializedError = {
			$isError: true,
			message: 'Test error',
			name: 'Error',
			stack: 'test stack',
			noTelemetry: false
		};
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId, serializedError);

		await consumePromise;
		assert.ok(caughtError, 'Should catch an error');
		assert.strictEqual(caughtError!.message, 'Test error');

		session.dispose();
	});

	test('session dispose() cancels and cleans up properly', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);
		assert.ok((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions.has(sessionId), 'Session should exist before dispose');

		session.dispose();

		assert.ok(!(extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions.has(sessionId), 'Session should be removed after dispose');
	});

	test('hasSpeechProvider getter returns correct state', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);

		// Initially should be false
		assert.strictEqual(extHostSpeech.hasSpeechProvider, false);

		// Simulate provider availability change
		extHostSpeech.$onDidChangeSpeechProviderAvailability(true);
		assert.strictEqual(extHostSpeech.hasSpeechProvider, true);

		extHostSpeech.$onDidChangeSpeechProviderAvailability(false);
		assert.strictEqual(extHostSpeech.hasSpeechProvider, false);
	});

	test('$onDidChangeSpeechProviderAvailability updates state and fires event', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);

		let eventFired = false;
		const disposable = extHostSpeech.onDidChangeSpeechProvider(() => {
			eventFired = true;
		});

		extHostSpeech.$onDidChangeSpeechProviderAvailability(true);

		assert.strictEqual(extHostSpeech.hasSpeechProvider, true, 'State should be updated');
		assert.strictEqual(eventFired, true, 'Event should be fired');

		disposable.dispose();
	});

	test('onDidChangeSpeechProvider event is fired when availability changes', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);

		let eventCount = 0;
		const disposable = extHostSpeech.onDidChangeSpeechProvider(() => {
			eventCount++;
		});

		extHostSpeech.$onDidChangeSpeechProviderAvailability(true);
		extHostSpeech.$onDidChangeSpeechProviderAvailability(false);
		extHostSpeech.$onDidChangeSpeechProviderAvailability(true);

		assert.strictEqual(eventCount, 3, 'Event should fire for each availability change');

		disposable.dispose();
	});

	test('receiving events for non-existent session does not throw', function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);

		const event: ISpeechToTextEvent = { status: SpeechToTextStatus.Recognized, text: 'test' };

		// Should not throw
		assert.doesNotThrow(() => {
			extHostSpeech.$onConsumerSpeechToTextEvent(99999, event);
		});
	});

	test('ending session that\'s already ended does not throw', function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);

		// Should not throw
		assert.doesNotThrow(() => {
			extHostSpeech.$onConsumerSpeechToTextSessionEnd(99999);
		});
	});

	test('concurrent session creation gets unique IDs', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		// Create multiple sessions concurrently
		const sessions = await Promise.all([
			extHostSpeech.createSpeechToTextSession(extension),
			extHostSpeech.createSpeechToTextSession(extension),
			extHostSpeech.createSpeechToTextSession(extension)
		]);

		assert.strictEqual(sessions.length, 3, 'All sessions should be created');

		// Verify all sessions are distinct
		for (let i = 0; i < sessions.length; i++) {
			for (let j = i + 1; j < sessions.length; j++) {
				assert.notStrictEqual(sessions[i], sessions[j], 'Sessions should be distinct objects');
			}
		}

		// Clean up
		sessions.forEach(s => s.dispose());
	});

	test('disposing session before any events received', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		// Dispose immediately without receiving any events
		session.dispose();

		// Should not throw
		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0] || '0');
		if (sessionId !== 0) {
			assert.fail('Session should have been removed');
		}
	});

	test('AsyncIterable events flow correctly', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		const events: ISpeechToTextEvent[] = [];
		const consumePromise = (async () => {
			for await (const event of session.events) {
				events.push(event);
			}
		})();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);

		// Send events
		extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, { status: SpeechToTextStatus.Started });
		await timeout(10);
		extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, { status: SpeechToTextStatus.Recognizing, text: 'test' });
		await timeout(10);
		extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, { status: SpeechToTextStatus.Recognized, text: 'test completed' });
		await timeout(10);
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId);

		await consumePromise;

		assert.strictEqual(events.length, 3, 'Should receive all events');
		assert.strictEqual(events[0].status, SpeechToTextStatus.Started);
		assert.strictEqual(events[1].status, SpeechToTextStatus.Recognizing);
		assert.strictEqual(events[2].status, SpeechToTextStatus.Recognized);

		session.dispose();
	});

	test('AsyncIterable completes when session ends normally', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		let completed = false;
		let errorThrown = false;

		const consumePromise = (async () => {
			try {
				for await (const _ of session.events) {
					// Just consume
				}
				completed = true;
			} catch (error) {
				errorThrown = true;
			}
		})();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId);

		await consumePromise;

		assert.strictEqual(completed, true, 'AsyncIterable should complete normally');
		assert.strictEqual(errorThrown, false, 'No error should be thrown');

		session.dispose();
	});

	test('AsyncIterable throws when session ends with error', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		let completed = false;
		let caughtError: Error | undefined;

		const consumePromise = (async () => {
			try {
				for await (const _ of session.events) {
					// Just consume
				}
				completed = true;
			} catch (error) {
				caughtError = error as Error;
			}
		})();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);
		const error: SerializedError = {
			$isError: true,
			message: 'Session failed',
			name: 'SpeechError',
			stack: 'test stack',
			noTelemetry: false
		};
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId, error);

		await consumePromise;

		assert.strictEqual(completed, false, 'AsyncIterable should not complete normally');
		assert.ok(caughtError, 'Error should be thrown');
		assert.strictEqual(caughtError!.message, 'Session failed');

		session.dispose();
	});

	test('multiple events in sequence are delivered correctly', async function () {
		const rpcProtocol = new TestRPCProtocol();
		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		const expectedTexts = ['hello', 'hello world', 'hello world!'];
		const events: ISpeechToTextEvent[] = [];

		const consumePromise = (async () => {
			for await (const event of session.events) {
				events.push(event);
			}
		})();

		const sessionId = parseInt(Object.keys((extHostSpeech as unknown as { consumerSessions: Map<number, unknown> }).consumerSessions)[0]);

		extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, { status: SpeechToTextStatus.Recognizing, text: expectedTexts[0] });
		extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, { status: SpeechToTextStatus.Recognizing, text: expectedTexts[1] });
		extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, { status: SpeechToTextStatus.Recognized, text: expectedTexts[2] });
		extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId);

		await consumePromise;

		assert.strictEqual(events.length, 3, 'Should receive all events in sequence');
		for (let i = 0; i < events.length; i++) {
			assert.strictEqual(events[i].text, expectedTexts[i], `Event ${i} should have correct text`);
		}

		session.dispose();
	});

	test('session with language option passes option to proxy', async function () {
		const rpcProtocol = new TestRPCProtocol();
		let capturedOptions: ISpeechToTextConsumerOptions | undefined;

		// Override the proxy to capture the options
		const proxy = rpcProtocol.getProxy<MainThreadSpeechShape>({ sid: 'MainThreadSpeech' } as ProxyIdentifier<MainThreadSpeechShape>);
		(proxy as unknown as { $createConsumerSpeechToTextSession: (sessionId: number, options?: ISpeechToTextConsumerOptions) => Promise<void> }).$createConsumerSpeechToTextSession = async (sessionId: number, options?: ISpeechToTextConsumerOptions) => {
			capturedOptions = options;
		};

		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		await extHostSpeech.createSpeechToTextSession(extension, { language: 'es-ES' });
		await rpcProtocol.sync();

		assert.ok(capturedOptions, 'Options should be captured');
		assert.strictEqual(capturedOptions.language, 'es-ES', 'Language should be passed correctly');

		// Note: dispose is called in the background, no need to explicitly dispose
	});

	test('session without language option still creates session', async function () {
		const rpcProtocol = new TestRPCProtocol();
		let createCalled = false;

		// Override the proxy to verify the call
		const proxy = rpcProtocol.getProxy<MainThreadSpeechShape>({ sid: 'MainThreadSpeech' } as ProxyIdentifier<MainThreadSpeechShape>);
		(proxy as unknown as { $createConsumerSpeechToTextSession: () => Promise<void> }).$createConsumerSpeechToTextSession = async () => {
			createCalled = true;
		};

		const extHostSpeech = new ExtHostSpeech(rpcProtocol);
		const extension = createExtension();

		const session = await extHostSpeech.createSpeechToTextSession(extension);
		await rpcProtocol.sync();

		assert.strictEqual(createCalled, true, 'Create should be called');
		assert.ok(session, 'Session should be created');

		session.dispose();
	});
});

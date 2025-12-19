/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionDescription, TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { ISpeechToTextConsumerOptions, MainThreadSpeechShape } from '../../common/extHost.protocol.js';
import { ExtHostSpeech } from '../../common/extHostSpeech.js';
import { SingleProxyRPCProtocol } from './testRPCProtocol.js';
import { SpeechToTextStatus } from '../../../contrib/speech/common/speechService.js';
import type * as vscode from 'vscode';

suite('ExtHostSpeech', function () {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const mockExtensionDescription: IExtensionDescription = {
		identifier: new ExtensionIdentifier('test-extension'),
		targetPlatform: TargetPlatform.UNIVERSAL,
		isBuiltin: false,
		isUserBuiltin: false,
		isUnderDevelopment: true,
		name: 'test-extension',
		publisher: 'test',
		version: '1.0.0',
		engines: { vscode: '*' },
		extensionLocation: URI.parse('file:///test'),
		enabledApiProposals: ['speechConsumer'],
		preRelease: false,
	};

	suite('Consumer API', function () {

		let extHostSpeech: ExtHostSpeech;
		let mainThreadCalls: { method: string; args: any[] }[];
		let hasSpeechProvider: boolean;
		let sessionEventCallbacks: Map<number, { onEvent: (event: any) => void; onEnd: (error?: any) => void }>;

		setup(function () {
			mainThreadCalls = [];
			hasSpeechProvider = true;
			sessionEventCallbacks = new Map();

			const mainThreadShape = new class extends mock<MainThreadSpeechShape>() {
				override async $hasSpeechProvider(): Promise<boolean> {
					mainThreadCalls.push({ method: '$hasSpeechProvider', args: [] });
					return hasSpeechProvider;
				}

				override async $createConsumerSpeechToTextSession(sessionId: number, options?: ISpeechToTextConsumerOptions): Promise<void> {
					mainThreadCalls.push({ method: '$createConsumerSpeechToTextSession', args: [sessionId, options] });
					if (!hasSpeechProvider) {
						throw new Error('No speech provider available');
					}
					// Store callbacks for later event simulation
					sessionEventCallbacks.set(sessionId, {
						onEvent: (event) => extHostSpeech.$onConsumerSpeechToTextEvent(sessionId, event),
						onEnd: (error) => extHostSpeech.$onConsumerSpeechToTextSessionEnd(sessionId, error)
					});
				}

				override async $cancelConsumerSpeechToTextSession(sessionId: number): Promise<void> {
					mainThreadCalls.push({ method: '$cancelConsumerSpeechToTextSession', args: [sessionId] });
					sessionEventCallbacks.delete(sessionId);
				}
			};

			const rpcProtocol = SingleProxyRPCProtocol(mainThreadShape);
			extHostSpeech = new ExtHostSpeech(rpcProtocol);
		});

		test('hasSpeechProvider initializes from main thread', async function () {
			// Wait for the initial $hasSpeechProvider call
			await new Promise(resolve => setTimeout(resolve, 10));

			assert.strictEqual(extHostSpeech.hasSpeechProvider, true);
			assert.ok(mainThreadCalls.some(c => c.method === '$hasSpeechProvider'));
		});

		test('hasSpeechProvider updates when provider availability changes', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));
			assert.strictEqual(extHostSpeech.hasSpeechProvider, true);

			// Simulate provider becoming unavailable
			extHostSpeech.$onDidChangeSpeechProviderAvailability(false);
			assert.strictEqual(extHostSpeech.hasSpeechProvider, false);

			// Simulate provider becoming available again
			extHostSpeech.$onDidChangeSpeechProviderAvailability(true);
			assert.strictEqual(extHostSpeech.hasSpeechProvider, true);
		});

		test('onDidChangeSpeechProvider fires when availability changes', async function () {
			let eventCount = 0;
			const disposable = extHostSpeech.onDidChangeSpeechProvider(() => {
				eventCount++;
			});
			store.add(disposable);

			extHostSpeech.$onDidChangeSpeechProviderAvailability(false);
			assert.strictEqual(eventCount, 1);

			extHostSpeech.$onDidChangeSpeechProviderAvailability(true);
			assert.strictEqual(eventCount, 2);
		});

		test('startSpeechToTextSession creates session and returns events iterable', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);
			store.add(session);

			assert.ok(session);
			assert.ok(session.events);
			assert.ok(typeof session.dispose === 'function');

			// Verify main thread was called
			const createCall = mainThreadCalls.find(c => c.method === '$createConsumerSpeechToTextSession');
			assert.ok(createCall);
			assert.deepStrictEqual(createCall.args[1], { language: undefined, context: 'extension' });
		});

		test('startSpeechToTextSession passes options to main thread', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription, { language: 'en-US' });
			store.add(session);

			const createCall = mainThreadCalls.find(c => c.method === '$createConsumerSpeechToTextSession');
			assert.ok(createCall);
			assert.deepStrictEqual(createCall.args[1], { language: 'en-US', context: 'extension' });
		});

		test('startSpeechToTextSession throws when no provider available', async function () {
			hasSpeechProvider = false;
			await new Promise(resolve => setTimeout(resolve, 10));

			await assert.rejects(
				extHostSpeech.startSpeechToTextSession(mockExtensionDescription),
				/No speech provider available/
			);
		});

		test('session events are streamed via AsyncIterable', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);
			store.add(session);

			const events: any[] = [];
			const eventPromise = (async () => {
				for await (const event of session.events) {
					events.push(event);
				}
			})();

			// Get the session callbacks
			const callbacks = sessionEventCallbacks.get(1);
			assert.ok(callbacks);

			// Simulate events from main thread
			callbacks.onEvent({ status: SpeechToTextStatus.Started });
			callbacks.onEvent({ status: SpeechToTextStatus.Recognizing, text: 'hello' });
			callbacks.onEvent({ status: SpeechToTextStatus.Recognized, text: 'hello world' });
			callbacks.onEnd();

			await eventPromise;

			assert.strictEqual(events.length, 3);
			assert.strictEqual(events[0].status, SpeechToTextStatus.Started);
			assert.strictEqual(events[1].status, SpeechToTextStatus.Recognizing);
			assert.strictEqual(events[1].text, 'hello');
			assert.strictEqual(events[2].status, SpeechToTextStatus.Recognized);
			assert.strictEqual(events[2].text, 'hello world');
		});

		test('session dispose cancels recognition', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);

			session.dispose();

			const cancelCall = mainThreadCalls.find(c => c.method === '$cancelConsumerSpeechToTextSession');
			assert.ok(cancelCall);
			assert.strictEqual(cancelCall.args[0], 1); // session ID
		});

		test('session events reject with error when error occurs', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);
			store.add(session);

			const events: any[] = [];
			let caughtError: Error | undefined;

			const eventPromise = (async () => {
				try {
					for await (const event of session.events) {
						events.push(event);
					}
				} catch (err) {
					caughtError = err as Error;
				}
			})();

			// Get the session callbacks
			const callbacks = sessionEventCallbacks.get(1);
			assert.ok(callbacks);

			// Simulate events and then error
			callbacks.onEvent({ status: SpeechToTextStatus.Started });
			callbacks.onEnd({ message: 'Test error', name: 'Error' });

			await eventPromise;

			assert.strictEqual(events.length, 1);
			assert.ok(caughtError);
			assert.strictEqual(caughtError.message, 'Test error');
		});

		test('multiple sessions have unique IDs', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session1 = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);
			const session2 = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);
			store.add(session1);
			store.add(session2);

			const createCalls = mainThreadCalls.filter(c => c.method === '$createConsumerSpeechToTextSession');
			assert.strictEqual(createCalls.length, 2);
			assert.notStrictEqual(createCalls[0].args[0], createCalls[1].args[0]); // Different session IDs
		});

		test('$onConsumerSpeechToTextEvent ignores events for cancelled sessions', async function () {
			await new Promise(resolve => setTimeout(resolve, 10));

			const session = await extHostSpeech.startSpeechToTextSession(mockExtensionDescription);

			const events: any[] = [];
			const eventPromise = (async () => {
				for await (const event of session.events) {
					events.push(event);
					if (events.length === 1) {
						// Dispose after first event
						session.dispose();
						break;
					}
				}
			})();

			const callbacks = sessionEventCallbacks.get(1);
			assert.ok(callbacks);

			// Send first event
			callbacks.onEvent({ status: SpeechToTextStatus.Started });

			await eventPromise;

			// Try to send another event after disposal - should be ignored
			extHostSpeech.$onConsumerSpeechToTextEvent(1, { status: SpeechToTextStatus.Recognizing, text: 'test' });

			assert.strictEqual(events.length, 1);
		});
	});

	suite('Provider Registration', function () {
		test('registerProvider calls main thread', function () {
			let registeredHandle: number | undefined;
			let registeredIdentifier: string | undefined;

			const mainThreadShape = new class extends mock<MainThreadSpeechShape>() {
				override $registerProvider(handle: number, identifier: string): void {
					registeredHandle = handle;
					registeredIdentifier = identifier;
				}
				override async $hasSpeechProvider(): Promise<boolean> {
					return false;
				}
			};

			const rpcProtocol = SingleProxyRPCProtocol(mainThreadShape);
			const extHostSpeech = new ExtHostSpeech(rpcProtocol);

			const mockProvider: vscode.SpeechProvider = {
				provideSpeechToTextSession: () => Promise.resolve(undefined),
				provideTextToSpeechSession: () => Promise.resolve(undefined),
				provideKeywordRecognitionSession: () => Promise.resolve(undefined),
			};

			const disposable = extHostSpeech.registerProvider(
				new ExtensionIdentifier('test.provider'),
				'test-provider-id',
				mockProvider
			);
			store.add(disposable);

			assert.ok(registeredHandle !== undefined);
			assert.strictEqual(registeredIdentifier, 'test-provider-id');
		});

		test('registerProvider dispose unregisters from main thread', function () {
			let unregisteredHandle: number | undefined;

			const mainThreadShape = new class extends mock<MainThreadSpeechShape>() {
				override $registerProvider(): void { }
				override $unregisterProvider(handle: number): void {
					unregisteredHandle = handle;
				}
				override async $hasSpeechProvider(): Promise<boolean> {
					return false;
				}
			};

			const rpcProtocol = SingleProxyRPCProtocol(mainThreadShape);
			const extHostSpeech = new ExtHostSpeech(rpcProtocol);

			const mockProvider: vscode.SpeechProvider = {
				provideSpeechToTextSession: () => Promise.resolve(undefined),
				provideTextToSpeechSession: () => Promise.resolve(undefined),
				provideKeywordRecognitionSession: () => Promise.resolve(undefined),
			};

			const disposable = extHostSpeech.registerProvider(
				new ExtensionIdentifier('test.provider'),
				'test-provider-id',
				mockProvider
			);

			disposable.dispose();

			assert.ok(unregisteredHandle !== undefined);
		});
	});
});

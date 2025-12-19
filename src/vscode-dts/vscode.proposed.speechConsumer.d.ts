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
		 * Start a new speech-to-text session.
		 *
		 * This starts listening to the default microphone and transcribes speech to text.
		 * The returned session provides an async iterable of events that can be consumed
		 * with a for-await-of loop.
		 *
		 * @example
		 * ```typescript
		 * const session = await vscode.speech.startSpeechToTextSession();
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
		export function startSpeechToTextSession(options?: SpeechToTextOptions): Thenable<SpeechToTextSession>;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

// This script runs within the webview itself
// It cannot access the VS Code API directly - uses message passing

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	// DOM Elements
	const providerUnavailable = /** @type {HTMLElement} */ (document.getElementById('provider-unavailable'));
	const mainContent = /** @type {HTMLElement} */ (document.getElementById('main-content'));
	const micButton = /** @type {HTMLButtonElement} */ (document.getElementById('mic-button'));
	const clearButton = /** @type {HTMLButtonElement} */ (document.getElementById('clear-button'));
	const recordingIndicator = /** @type {HTMLElement} */ (document.getElementById('recording-indicator'));
	const interimText = /** @type {HTMLElement} */ (document.getElementById('interim-text'));
	const transcript = /** @type {HTMLElement} */ (document.getElementById('transcript'));
	const statusMessage = /** @type {HTMLElement} */ (document.getElementById('status-message'));
	const installExtensionLink = /** @type {HTMLElement} */ (document.getElementById('install-extension-link'));

	// State
	let isListening = false;
	let providerAvailable = false;

	// Restore state
	const previousState = vscode.getState();
	if (previousState) {
		if (previousState.transcript && transcript) {
			transcript.textContent = previousState.transcript;
		}
	}

	// Event Listeners
	micButton.addEventListener('click', () => {
		if (!providerAvailable) {
			return;
		}
		vscode.postMessage({ type: 'toggleListening' });
	});

	clearButton.addEventListener('click', () => {
		transcript.textContent = '';
		interimText.textContent = '';
		interimText.classList.add('hidden');
		hideStatus();
		saveState();
		vscode.postMessage({ type: 'clearTranscript' });
	});

	installExtensionLink.addEventListener('click', (e) => {
		e.preventDefault();
		vscode.postMessage({ type: 'installExtension' });
	});

	// Handle messages from the extension
	window.addEventListener('message', (event) => {
		const message = event.data;

		switch (message.type) {
			case 'listeningState':
				updateListeningState(message.isListening);
				break;

			case 'providerState':
				updateProviderState(message.available);
				break;

			case 'interim':
				showInterimText(message.text);
				break;

			case 'final':
				appendFinalText(message.text);
				break;

			case 'status':
				if (message.status === 'started') {
					showStatus('Speech recognition started', 'info');
					setTimeout(hideStatus, 2000);
				}
				break;

			case 'error':
				showStatus(message.message, 'error');
				break;
		}
	});

	/**
	 * Update UI based on listening state
	 * @param {boolean} listening
	 */
	function updateListeningState(listening) {
		isListening = listening;

		if (listening) {
			micButton.classList.add('listening');
			micButton.title = 'Stop listening';
			micButton.innerHTML = '<i class="codicon codicon-debug-stop"></i>';
			recordingIndicator.classList.remove('hidden');
		} else {
			micButton.classList.remove('listening');
			micButton.title = 'Start listening';
			micButton.innerHTML = '<i class="codicon codicon-mic"></i>';
			recordingIndicator.classList.add('hidden');
			interimText.classList.add('hidden');
		}
	}

	/**
	 * Update UI based on provider availability
	 * @param {boolean} available
	 */
	function updateProviderState(available) {
		providerAvailable = available;

		if (available) {
			providerUnavailable.classList.add('hidden');
			mainContent.classList.remove('disabled');
			micButton.disabled = false;
		} else {
			providerUnavailable.classList.remove('hidden');
			mainContent.classList.add('disabled');
			micButton.disabled = true;

			// Stop listening if provider becomes unavailable
			if (isListening) {
				updateListeningState(false);
			}
		}
	}

	/**
	 * Show interim (in-progress) recognition text
	 * @param {string} text
	 */
	function showInterimText(text) {
		interimText.textContent = text;
		interimText.classList.remove('hidden');
	}

	/**
	 * Append final recognized text to transcript
	 * @param {string} text
	 */
	function appendFinalText(text) {
		// Hide interim text
		interimText.classList.add('hidden');
		interimText.textContent = '';

		// Append to transcript with space if needed
		const currentText = transcript.textContent || '';
		if (currentText && !currentText.endsWith(' ') && !currentText.endsWith('\n')) {
			transcript.textContent = currentText + ' ' + text;
		} else {
			transcript.textContent = currentText + text;
		}

		// Scroll to bottom
		transcript.scrollTop = transcript.scrollHeight;

		// Save state
		saveState();
	}

	/**
	 * Show a status message
	 * @param {string} message
	 * @param {'info' | 'error'} type
	 */
	function showStatus(message, type) {
		statusMessage.textContent = message;
		statusMessage.className = 'status-message ' + type;
		statusMessage.classList.remove('hidden');
	}

	/**
	 * Hide the status message
	 */
	function hideStatus() {
		statusMessage.classList.add('hidden');
	}

	/**
	 * Save state for persistence across webview reloads
	 */
	function saveState() {
		vscode.setState({
			transcript: transcript.textContent
		});
	}

	// Signal to extension that webview is ready
	vscode.postMessage({ type: 'ready' });
}());

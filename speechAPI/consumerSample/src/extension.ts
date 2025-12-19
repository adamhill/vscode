/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * VS Speech extension marketplace link
 */
const VS_SPEECH_EXTENSION_URL = 'https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech';
const VS_SPEECH_EXTENSION_ID = 'ms-vscode.vscode-speech';

/**
 * Type augmentation for the proposed speechConsumer API.
 * This matches the proposed API shape from vscode.proposed.speechConsumer.d.ts
 */
declare module 'vscode' {
	interface SpeechToTextSession {
		readonly events: AsyncIterable<SpeechToTextEvent>;
		dispose(): void;
	}

	namespace speech {
		export const hasSpeechProvider: boolean;
		export const onDidChangeSpeechProvider: vscode.Event<void>;
		export function createSpeechToTextSession(options?: SpeechToTextOptions): Thenable<SpeechToTextSession>;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new SpeechTranscriptionViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SpeechTranscriptionViewProvider.viewType,
			provider
		)
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('speechConsumer.startListening', () => {
			provider.startListening();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('speechConsumer.stopListening', () => {
			provider.stopListening();
		})
	);
}

export function deactivate() {
	// Cleanup handled by disposables
}

/**
 * WebviewViewProvider for the Speech Transcription sidebar panel.
 * Provides a microphone button, recording indicator, and text area for transcription.
 */
class SpeechTranscriptionViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'speechConsumer.transcriptionView';

	private _view?: vscode.WebviewView;
	private _session?: vscode.SpeechToTextSession;
	private _isListening = false;
	private _providerAvailabilityListener?: vscode.Disposable;

	constructor(
		private readonly _extensionUri: vscode.Uri
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (data: { type: string }) => {
			switch (data.type) {
				case 'toggleListening':
					if (this._isListening) {
						this.stopListening();
					} else {
						this.startListening();
					}
					break;

				case 'clearTranscript':
					// Just acknowledge - webview handles clearing locally
					break;

				case 'openExtensionLink':
					vscode.env.openExternal(vscode.Uri.parse(VS_SPEECH_EXTENSION_URL));
					break;

				case 'installExtension':
					vscode.commands.executeCommand(
						'workbench.extensions.installExtension',
						VS_SPEECH_EXTENSION_ID
					);
					break;

				case 'ready':
					// Webview is ready, send initial state
					this._updateProviderState();
					break;
			}
		});

		// Listen for provider availability changes
		this._providerAvailabilityListener = vscode.speech.onDidChangeSpeechProvider(() => {
			this._updateProviderState();
		});

		webviewView.onDidDispose(() => {
			this.stopListening();
			this._providerAvailabilityListener?.dispose();
		});
	}

	/**
	 * Start listening for speech and transcribing to text.
	 */
	public async startListening(): Promise<void> {
		if (this._isListening || !this._view) {
			return;
		}

		// Check if speech provider is available
		if (!vscode.speech.hasSpeechProvider) {
			this._view.webview.postMessage({
				type: 'error',
				message: 'No speech provider available. Please install the VS Code Speech extension.'
			});
			return;
		}

		try {
			this._isListening = true;
			this._updateListeningState();

			// Create speech-to-text session
			this._session = await vscode.speech.createSpeechToTextSession({
				language: vscode.env.language // Use VS Code's language setting
			});

			// Process speech events
			for await (const event of this._session.events) {
				if (!this._isListening) {
					break;
				}

				switch (event.status) {
					case vscode.SpeechToTextStatus.Started:
						this._view?.webview.postMessage({
							type: 'status',
							status: 'started'
						});
						break;

					case vscode.SpeechToTextStatus.Recognizing:
						// Interim result
						if (event.text) {
							this._view?.webview.postMessage({
								type: 'interim',
								text: event.text
							});
						}
						break;

					case vscode.SpeechToTextStatus.Recognized:
						// Final result
						if (event.text) {
							this._view?.webview.postMessage({
								type: 'final',
								text: event.text
							});
						}
						break;

					case vscode.SpeechToTextStatus.Error:
						this._view?.webview.postMessage({
							type: 'error',
							message: event.text || 'Speech recognition error'
						});
						this._stopSession();
						break;

					case vscode.SpeechToTextStatus.Stopped:
						this._stopSession();
						break;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			this._view?.webview.postMessage({
				type: 'error',
				message: `Failed to start speech recognition: ${message}`
			});
			this._stopSession();
		}
	}

	/**
	 * Stop listening and dispose the speech session.
	 */
	public stopListening(): void {
		this._stopSession();
	}

	private _stopSession(): void {
		if (this._session) {
			this._session.dispose();
			this._session = undefined;
		}
		this._isListening = false;
		this._updateListeningState();
	}

	private _updateListeningState(): void {
		this._view?.webview.postMessage({
			type: 'listeningState',
			isListening: this._isListening
		});
	}

	private _updateProviderState(): void {
		const hasProvider = vscode.speech.hasSpeechProvider;
		this._view?.webview.postMessage({
			type: 'providerState',
			available: hasProvider,
			extensionUrl: VS_SPEECH_EXTENSION_URL
		});

		// If provider becomes unavailable while listening, stop
		if (!hasProvider && this._isListening) {
			this.stopListening();
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
		);
		const styleResetUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css')
		);
		const styleVSCodeUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css')
		);
		const styleMainUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
		);
		const codiconsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
		);

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">

	<link href="${styleResetUri}" rel="stylesheet">
	<link href="${styleVSCodeUri}" rel="stylesheet">
	<link href="${styleMainUri}" rel="stylesheet">
	<link href="${codiconsUri}" rel="stylesheet">

	<title>Speech Transcription</title>
</head>
<body>
	<!-- Provider unavailable message -->
	<div id="provider-unavailable" class="provider-message hidden">
		<div class="provider-icon">
			<i class="codicon codicon-warning"></i>
		</div>
		<p>No speech provider available.</p>
		<p class="provider-link">
			<a href="#" id="install-extension-link">Install the VS Code Speech extension</a>
		</p>
	</div>

	<!-- Main content -->
	<div id="main-content">
		<!-- Controls -->
		<div class="controls">
			<button id="mic-button" class="mic-button" title="Start listening">
				<i class="codicon codicon-mic"></i>
			</button>
			<button id="clear-button" class="clear-button" title="Clear transcript">
				<i class="codicon codicon-clear-all"></i>
			</button>
		</div>

		<!-- Recording indicator -->
		<div id="recording-indicator" class="recording-indicator hidden">
			<span class="recording-dot"></span>
			<span class="recording-text">Listening...</span>
		</div>

		<!-- Interim text (shows current recognition) -->
		<div id="interim-text" class="interim-text hidden"></div>

		<!-- Transcript area -->
		<div class="transcript-container">
			<div id="transcript" class="transcript" placeholder="Transcribed text will appear here..."></div>
		</div>

		<!-- Status messages -->
		<div id="status-message" class="status-message hidden"></div>
	</div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

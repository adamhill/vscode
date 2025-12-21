# Testing & Debugging Strategy for VS Code SpeechConsumer API

## Overview

You need to test modifications to VS Code's internal code (ExtHost/MainThread) **AND** an extension that consumes the new API. The key is running your **locally built VS Code** (not production) as the Extension Development Host.

---

## The Problem Explained

When you open `speechAPI/consumerSample/` and press F5, the default launch configuration uses your **installed VS Code** (or Insiders), which **doesn't have your SpeechConsumer API changes**. You need it to use your **locally built modified VS Code** instead.

---

## Solution: Two-Part Testing Strategy

### Part 1: Build Your Modified VS Code

**From the VS Code source root** (`/Users/adamhill/dev/microsoft/vscode`):

```bash
# 1. Ensure TypeScript build watch is running
# Check if "VS Code - Build" task is active in VS Code
# Or start it: Terminal → Run Task → "VS Code - Build"

# 2. First-time setup: Install dependencies and build Electron
yarn install
yarn electron

# 3. Run your modified VS Code from source
./scripts/code.sh
# On Windows: .\scripts\code.bat
# On Windows PowerShell: .\scripts\code.ps1
```

**What this does:**

- Launches VS Code using your **locally compiled code** with SpeechConsumer API
- This instance will be used as the Extension Development Host
- Any breakpoints in [`mainThreadSpeech.ts`](src/vs/workbench/api/browser/mainThreadSpeech.ts:1) or [`extHostSpeech.ts`](src/vs/workbench/api/common/extHostSpeech.ts:1) will work

---

### Part 2: Load and Debug Your Extension

**Option A: Debug Extension from Modified VS Code** (Recommended)

1. **Launch your modified VS Code:**

   ```bash
   cd /Users/adamhill/dev/microsoft/vscode
   ./scripts/code.sh
   ```

2. **Open your extension in the modified instance:**

   ```
   File → Open Folder → Navigate to speechAPI/consumerSample/
   ```

3. **Press F5 to launch Extension Development Host**
   - It will launch **another** instance of your modified VS Code
   - This new instance (`[Extension Development Host]`) runs your extension
   - The original instance is the debugger

4. **Test your extension:**
   - In the Extension Development Host window, open Command Palette
   - Run "Start Speech Recognition" command
   - Speak to test transcription

**Option B: Debug Both VS Code Core and Extension Simultaneously**

For advanced debugging where you need breakpoints in **both** VS Code core and extension:

1. **Launch VS Code with debug port:**

   ```bash
   cd /Users/adamhill/dev/microsoft/vscode
   ./scripts/code.sh --inspect-extensions=9333
   ```

2. **In your extension project** (`speechAPI/consumerSample/.vscode/launch.json`), add:

   ```json
   {
     "name": "Attach to Extension Host",
     "type": "node",
     "request": "attach",
     "port": 9333,
     "restart": true,
     "timeout": 60000,
     "sourceMaps": true,
     "outFiles": ["${workspaceFolder}/out/**/*.js"]
   }
   ```

3. **Set breakpoints** in both:
   - VS Code source: [`mainThreadSpeech.ts`](src/vs/workbench/api/browser/mainThreadSpeech.ts:183), [`extHostSpeech.ts`](src/vs/workbench/api/common/extHostSpeech.ts:178)
   - Extension: `speechAPI/consumerSample/src/extension.ts`

4. **Start debugging:**
   - Run the extension normally (F5)
   - In VS Code, use "Attach to Extension Host" debug config
   - Both debuggers will work simultaneously

---

## Debugging Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: Build Modified VS Code                                  │
│   $ cd /Users/adamhill/dev/microsoft/vscode                     │
│   $ yarn && yarn electron                                       │
│   $ ./scripts/code.sh                                           │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: Your Modified VS Code Opens                            │
│   Contains: SpeechConsumer API implementation                   │
│   Files: mainThreadSpeech.ts, extHostSpeech.ts, etc.          │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: Open Extension Project                                  │
│   File → Open → speechAPI/consumerSample/                      │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: Press F5                                                │
│   Launches Extension Development Host                           │
│   Host uses YOUR modified VS Code build                         │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: Test Extension                                          │
│   Run command in Extension Development Host                     │
│   Breakpoints work in BOTH:                                     │
│     • Extension code (speechAPI/consumerSample/src/)           │
│     • VS Code core (src/vs/workbench/api/)                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Launch Configurations Reference

### VS Code Source Repository

**File:** `.vscode/launch.json` (in VS Code source root)

Key launch configs for debugging VS Code itself:

```json
{
  "name": "Launch VS Code",
  "type": "node",
  "request": "launch",
  "program": "${workspaceFolder}/out/main.js",
  "args": ["--inspect-extensions=9333"],
  "outFiles": ["${workspaceFolder}/out/**/*.js"]
}
```

### Extension Project

**File:** [`speechAPI/consumerSample/.vscode/launch.json`](speechAPI/consumerSample/.vscode/launch.json:1)

Already configured with:

```json
{
  "name": "Run Extension",
  "type": "extensionHost",
  "request": "launch",
  "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
  "outFiles": ["${workspaceFolder}/out/**/*.js"]
}
```

**To use your modified VS Code,** add `extensionDevelopmentKind`:

```json
{
  "name": "Run Extension (Custom Build)",
  "type": "extensionHost",
  "request": "launch",
  "runtimeExecutable": "${execPath}",
  "args": [
    "--extensionDevelopmentPath=${workspaceFolder}",
    "--disable-extensions"
  ],
  "outFiles": ["${workspaceFolder}/out/**/*.js"]
}
```

When launched from your built VS Code, `${execPath}` automatically uses the modified version.

---

## Testing Checklist

### 1. Unit Tests (Already Complete ✅)

```bash
cd /Users/adamhill/dev/microsoft/vscode
./scripts/test.sh --grep "SpeechConsumer"
```

### 2. Integration Test with Extension

**Step-by-step:**

1. ✅ **Build modified VS Code**

   ```bash
   ./scripts/code.sh
   ```

2. ✅ **Open extension project**

   ```
   File → Open → speechAPI/consumerSample/
   ```

3. ✅ **Verify proposed API is enabled**
   - Check [`package.json`](speechAPI/consumerSample/package.json:1) has:

     ```json
     "enabledApiProposals": ["speechConsumer"]
     ```

4. ✅ **Set breakpoints** (for debugging):
   - Extension: `speechAPI/consumerSample/src/extension.ts:30` (in command handler)
   - Core: [`extHostSpeech.ts:178`](src/vs/workbench/api/common/extHostSpeech.ts:178) (`createSpeechToTextSession`)
   - Core: [`mainThreadSpeech.ts:183`](src/vs/workbench/api/browser/mainThreadSpeech.ts:183) (`$createConsumerSpeechToTextSession`)

5. ✅ **Launch Extension Development Host** (Press F5)

6. ✅ **Test the API:**
   - Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
   - Run: "Start Speech Recognition"
   - Verify:
     - ✓ No "API not found" errors
     - ✓ Session created successfully
     - ✓ Events stream via AsyncIterable
     - ✓ Provider availability checked
     - ✓ Transcription works (if you have a speech provider)

7. ✅ **Check logs:**
   - In Extension Development Host: `Help → Toggle Developer Tools`
   - Check Console for:

     ```
     [Speech] Extension creating consumer session <sessionId>
     ```

---

## Common Issues & Solutions

### Issue 1: "vscode.speech.createSpeechToTextSession is not a function"

**Cause:** Extension Development Host using production VS Code
**Solution:** Launch from your built VS Code using `./scripts/code.sh`

### Issue 2: "enabledApiProposals cannot use 'speechConsumer'"

**Cause:** Proposal not registered
**Solution:** Verify [`extensionsApiProposals.ts`](src/vs/platform/extensions/common/extensionsApiProposals.ts:379) has `speechConsumer` entry

### Issue 3: Breakpoints in mainThreadSpeech.ts not hitting

**Cause:** Source maps not loaded
**Solution:**

```bash
# Rebuild with source maps
yarn watch
# Or use VS Code - Build task
```

### Issue 4: "No speech provider available"

**Expected:** You need a speech provider extension registered
**Solution:** This is normal if no provider is installed. Test with mock provider or verify `hasSpeechProvider` is `false`

---

## Debug Logs to Check

### ExtHost Side

In Extension Development Host Console:

```typescript
// From extHostSpeech.ts
console.log('Creating consumer session:', sessionId);
console.log('Session events ready, provider available:', hasSpeechProvider);
```

### MainThread Side

In Extension Development Host Console (same window):

```typescript
// From mainThreadSpeech.ts
$createConsumerSpeechToTextSession logs:
"[Speech] Extension creating consumer session"
```

### Extension Side

```typescript
// Your extension code
console.log('Session created:', session);
console.log('Event received:', event);
```

---

## Advanced: Testing with VS Code Insiders

If you want to test against Insiders build (which also has proposed APIs):

```bash
# Build with Insiders-compatible API version
cd /Users/adamhill/dev/microsoft/vscode
yarn && yarn gulp vscode-darwin-min  # macOS
# yarn gulp vscode-win32-x64-min      # Windows
# yarn gulp vscode-linux-x64-min      # Linux
```

Then symlink or copy to Insiders:

```bash
# Create development build
./scripts/code.sh --extensions-dir ~/.vscode-insiders/extensions
```

---

## Recommended Testing Order

1. **Unit Tests First** (Already complete ✅)
   - Validates core functionality
   - Run: `./scripts/test.sh --grep "SpeechConsumer"`

2. **Manual Integration Test**
   - Launch modified VS Code
   - Open extension, press F5
   - Test basic API calls

3. **Debugger Validation**
   - Set breakpoints in ExtHost/MainThread
   - Step through session creation
   - Verify event flow

4. **End-to-End Test**
   - Install a real speech provider (or create mock)
   - Test full transcription workflow
   - Verify AsyncIterable streaming

---

## Quick Reference Commands

```bash
# In VS Code source root
./scripts/code.sh                    # Launch modified VS Code
./scripts/code.sh --verbose          # With extra logging
./scripts/test.sh --grep "Speech"    # Run speech tests
yarn watch                           # Continuous build

# Check if build is current
git status out/                      # Should show compiled files
```

---

## Summary

**The key insight:** Using `./scripts/code.sh` launches VS Code with your modifications. When you press F5 from that instance, the Extension Development Host **inherits** your modifications, making the SpeechConsumer API available to your extension.

Your testing workflow is:

1. Build: `yarn && ./scripts/code.sh`
2. Open extension: `File → Open → speechAPI/consumerSample/`
3. Debug: Press F5
4. Test: Run command in Extension Development Host

This ensures your extension **always** runs against your modified VS Code build containing the SpeechConsumer API changes.

----

This was from a weird - "Enhance Prompt" result when I asks the LLM to write out the instructions for testing the speech API.

----

# Testing VS Code Modifications and Consuming Extensions

## Overview

This document provides a comprehensive strategy for testing VS Code core modifications (specifically the Speech Consumer API) and developing extensions that consume the new API.

## Part 1: Testing VS Code Core Modifications

### 1.1 Development Environment Setup

```bash
# Clone and setup VS Code
git clone https://github.com/microsoft/vscode.git
cd vscode
yarn install

# Build in watch mode for continuous development
yarn watch
```

### 1.2 Running Unit Tests

```bash
# Run all tests
yarn test

# Run specific test suite
yarn test --grep "MainThreadSpeech"
yarn test --grep "ExtHostSpeech"

# Run tests in watch mode
yarn test --watch

# Run browser tests specifically
yarn test-browser --grep "Speech"

# Run with coverage
yarn test --coverage
```

### 1.3 Manual Testing with Extension Host

```bash
# Launch VS Code from source with Extension Development Host
code --extensionDevelopmentPath=/path/to/test-extension

# Or use the built-in launch configuration
# Press F5 in VS Code to start debugging
# Select "Launch VS Code Extension" configuration
```

### 1.4 Validation Checklist

- [ ] All unit tests pass (50+ tests for Speech API)
- [ ] TypeScript compilation succeeds without errors
- [ ] No console errors in developer tools
- [ ] Protocol messages flow correctly between ExtHost and MainThread
- [ ] Event listeners are properly registered and cleaned up
- [ ] Memory leaks are not present (use Chrome DevTools Memory profiler)
- [ ] Error handling works correctly for edge cases

## Part 2: Creating Consumer Extensions

### 2.1 Basic Extension Setup

```bash
# Create new extension from template
npm install -g yo generator-code
yo code

# Select TypeScript extension
# Follow prompts to create extension structure
```

### 2.2 Extension Manifest Configuration

**package.json:**

```json
{
  "name": "speech-consumer-test",
  "version": "0.0.1",
  "engines": {
    "vscode": "^1.85.0"
  },
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./out/extension.js",
  "contributes": {}
}
```

### 2.3 Sample Consumer Extension

**src/extension.ts:**

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Speech Consumer Test Extension activated');

    // Test 1: Check provider availability
    const checkProvider = vscode.commands.registerCommand('speech.checkProvider', async () => {
        const hasProvider = await vscode.speech.hasSpeechProvider();
        vscode.window.showInformationMessage(`Speech provider available: ${hasProvider}`);
    });

    // Test 2: Start recognition session
    const startRecognition = vscode.commands.registerCommand('speech.startRecognition', async () => {
        try {
            const session = await vscode.speech.recognizeSpeech({
                language: 'en-US'
            });

            session.onDidChange(event => {
                console.log('Recognition result:', event.text);
                if (event.isFinal) {
                    vscode.window.showInformationMessage(`Final: ${event.text}`);
                } else {
                    vscode.window.setStatusBarMessage(`Interim: ${event.text}`, 2000);
                }
            });

            session.onDidEnd(() => {
                console.log('Recognition session ended');
                vscode.window.showInformationMessage('Speech recognition ended');
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    // Test 3: Start synthesis session
    const startSynthesis = vscode.commands.registerCommand('speech.startSynthesis', async () => {
        try {
            const text = await vscode.window.showInputBox({
                prompt: 'Enter text to synthesize'
            });

            if (!text) return;

            const session = await vscode.speech.synthesizeSpeech(text, {
                language: 'en-US'
            });

            session.onDidEnd(() => {
                vscode.window.showInformationMessage('Speech synthesis completed');
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    // Test 4: Listen for provider changes
    const providerDisposable = vscode.speech.onDidChangeSpeechProviderAvailability(available => {
        vscode.window.showInformationMessage(`Provider availability changed: ${available}`);
    });

    context.subscriptions.push(
        checkProvider,
        startRecognition,
        startSynthesis,
        providerDisposable
    );
}

export function deactivate() {
    console.log('Speech Consumer Test Extension deactivated');
}
```

### 2.4 Testing the Consumer Extension

```bash
# Build the extension
cd /path/to/speech-consumer-test
npm install
npm run compile

# Launch VS Code with the extension
code --extensionDevelopmentPath=/path/to/speech-consumer-test /path/to/test-workspace
```

### 2.5 Extension Test Suite

**src/test/suite/extension.test.ts:**

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Speech Consumer API Tests', () => {

    test('hasSpeechProvider returns boolean', async () => {
        const hasProvider = await vscode.speech.hasSpeechProvider();
        assert.strictEqual(typeof hasProvider, 'boolean');
    });

    test('recognizeSpeech creates valid session', async () => {
        try {
            const session = await vscode.speech.recognizeSpeech({
                language: 'en-US'
            });
            assert.ok(session);
            assert.ok(typeof session.stop === 'function');
            session.stop();
        } catch (error) {
            // Provider might not be available in test environment
            assert.ok(error);
        }
    });

    test('synthesizeSpeech creates valid session', async () => {
        try {
            const session = await vscode.speech.synthesizeSpeech('test', {
                language: 'en-US'
            });
            assert.ok(session);
            assert.ok(typeof session.stop === 'function');
            session.stop();
        } catch (error) {
            // Provider might not be available in test environment
            assert.ok(error);
        }
    });

    test('onDidChangeSpeechProviderAvailability registers listener', () => {
        let called = false;
        const disposable = vscode.speech.onDidChangeSpeechProviderAvailability(() => {
            called = true;
        });
        disposable.dispose();
        // Event might not fire during test, but registration should succeed
        assert.ok(true);
    });
});
```

## Part 3: Debugging Strategies

### 3.1 VS Code Core Debugging

**Launch Configuration (.vscode/launch.json):**

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "extensionHost",
            "request": "launch",
            "name": "Launch VS Code with Extension",
            "runtimeExecutable": "${execPath}",
            "args": [
                "--extensionDevelopmentPath=${workspaceFolder}"
            ],
            "outFiles": [
                "${workspaceFolder}/out/**/*.js"
            ],
            "preLaunchTask": "npm: watch"
        },
        {
            "type": "chrome",
            "request": "launch",
            "name": "Debug Main Process",
            "runtimeExecutable": "${execPath}",
            "runtimeArgs": [
                "--remote-debugging-port=9222"
            ],
            "webRoot": "${workspaceFolder}"
        }
    ]
}
```

### 3.2 Debugging Techniques

**Add logging to MainThreadSpeech:**

```typescript
$recognizeSpeech(sessionId: number, options: ISpeechToTextOptions): Promise<void> {
    console.log('[MainThreadSpeech] recognizeSpeech called', { sessionId, options });
    // ... rest of implementation
}
```

**Add logging to ExtHostSpeech:**

```typescript
recognizeSpeech(options: vscode.SpeechToTextOptions): Promise<vscode.SpeechToTextSession> {
    console.log('[ExtHostSpeech] recognizeSpeech called', options);
    // ... rest of implementation
}
```

**Monitor protocol messages:**

```typescript
// In extHost.protocol.ts
console.log('Protocol message:', method, args);
```

### 3.3 Chrome DevTools Inspection

```bash
# Launch with remote debugging
code --inspect-extensions=9333

# Connect Chrome to chrome://inspect
# Set breakpoints in ExtHost code
```

### 3.4 Main Process Debugging

```bash
# Launch VS Code with Node debugging
code --inspect-brk=5870

# Attach debugger in another VS Code instance
# Debug > Attach to Node Process
```

## Part 4: Integration Testing

### 4.1 End-to-End Test Scenarios

**Scenario 1: Provider Registration and Consumer Usage**

```typescript
// Provider extension registers
vscode.speech.registerSpeechProvider('test-provider', provider);

// Consumer extension uses API
const hasProvider = await vscode.speech.hasSpeechProvider();
assert.strictEqual(hasProvider, true);
```

**Scenario 2: Multiple Sessions**

```typescript
const session1 = await vscode.speech.recognizeSpeech({ language: 'en-US' });
const session2 = await vscode.speech.recognizeSpeech({ language: 'es-ES' });

// Both should work independently
assert.ok(session1);
assert.ok(session2);
```

**Scenario 3: Error Handling**

```typescript
try {
    // Provider not available
    await vscode.speech.recognizeSpeech({});
} catch (error) {
    assert.ok(error.message.includes('provider'));
}
```

### 4.2 Performance Testing

**Measure session creation time:**

```typescript
const start = performance.now();
const session = await vscode.speech.recognizeSpeech(options);
const duration = performance.now() - start;
console.log(`Session creation took ${duration}ms`);
assert.ok(duration < 100); // Should be fast
```

**Memory leak detection:**

```typescript
// Create and destroy many sessions
for (let i = 0; i < 100; i++) {
    const session = await vscode.speech.recognizeSpeech(options);
    session.stop();
}
// Check memory usage in DevTools
```

## Part 5: Common Issues and Troubleshooting

### 5.1 Provider Not Available

**Issue:** `vscode.speech.hasSpeechProvider()` returns false

**Solutions:**

- Verify provider extension is installed and activated
- Check extension activation events
- Ensure provider registration succeeds
- Check for registration errors in console

### 5.2 Session Not Creating

**Issue:** `recognizeSpeech()` or `synthesizeSpeech()` fails

**Solutions:**

- Verify provider is available
- Check options are valid
- Ensure MainThread service is initialized
- Check proxy method signatures match protocol

### 5.3 Events Not Firing

**Issue:** `onDidChange` or `onDidEnd` never called

**Solutions:**

- Verify event emitter is properly connected
- Check session ID mapping
- Ensure events are forwarded through protocol
- Verify listener registration

### 5.4 Type Errors

**Issue:** TypeScript compilation errors

**Solutions:**

- Ensure vscode.d.ts is updated
- Check protocol definitions match implementation
- Verify all types are exported correctly
- Run `yarn compile` in VS Code source

## Part 6: Continuous Integration

### 6.1 Automated Testing

**GitHub Actions Workflow (.github/workflows/test.yml):**

```yaml
name: Test Speech API

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: yarn install
      - run: yarn compile
      - run: yarn test --grep "Speech"
      - run: yarn test-browser --grep "Speech"
```

### 6.2 Pre-commit Hooks

**package.json:**

```json
{
  "husky": {
    "hooks": {
      "pre-commit": "yarn lint && yarn test --grep Speech"
    }
  }
}
```

## Part 7: Documentation for Extension Developers

### 7.1 API Usage Guide

Create comprehensive documentation in VS Code wiki or README:

```markdown
# Speech Consumer API

## Overview
The Speech API allows extensions to consume speech recognition and synthesis
capabilities provided by other extensions.

## Basic Usage

### Check Provider Availability
```typescript
const hasProvider = await vscode.speech.hasSpeechProvider();
```

### Speech Recognition

```typescript
const session = await vscode.speech.recognizeSpeech({
    language: 'en-US'
});

session.onDidChange(event => {
    console.log(event.text, event.isFinal);
});
```

### Speech Synthesis

```typescript
const session = await vscode.speech.synthesizeSpeech('Hello world', {
    language: 'en-US'
});
```

```

### 7.2 Migration Guide

For extensions upgrading from previous API versions:

```markdown
# Migration Guide

## Version 1.0 to 2.0

### Breaking Changes
- `recognizeSpeech()` now returns Promise
- Session IDs are managed internally
- New event types for results

### Migration Steps
1. Update API calls to use Promises
2. Replace event handlers with new types
3. Remove manual session management
```

## Part 8: Best Practices

### 8.1 Resource Management

```typescript
// Always dispose sessions when done
const session = await vscode.speech.recognizeSpeech(options);
try {
    // Use session
} finally {
    session.stop();
}

// Dispose event listeners
const disposable = vscode.speech.onDidChangeSpeechProviderAvailability(handler);
context.subscriptions.push(disposable);
```

### 8.2 Error Handling

```typescript
try {
    const session = await vscode.speech.recognizeSpeech(options);
} catch (error) {
    if (error.message.includes('No provider')) {
        vscode.window.showWarningMessage('Install a speech provider extension');
    } else {
        vscode.window.showErrorMessage(`Speech error: ${error.message}`);
    }
}
```

### 8.3 User Experience

```typescript
// Show progress during long operations
await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Starting speech recognition...'
}, async () => {
    const session = await vscode.speech.recognizeSpeech(options);
    return session;
});

// Provide feedback for interim results
session.onDidChange(event => {
    if (!event.isFinal) {
        vscode.window.setStatusBarMessage(`Speaking: ${event.text}`, 1000);
    }
});
```

## Part 9: Verification Checklist

### 9.1 Before Submitting PR

- [ ] All unit tests pass (50+ tests)
- [ ] Manual testing with sample extension succeeds
- [ ] No TypeScript compilation errors
- [ ] API documentation is complete
- [ ] Migration guide is provided if needed
- [ ] Performance is acceptable (< 100ms for session creation)
- [ ] No memory leaks detected
- [ ] Edge cases are handled (no provider, invalid options, etc.)
- [ ] Error messages are user-friendly
- [ ] Code follows VS Code contribution guidelines

### 9.2 Extension Testing

- [ ] Extension activates correctly
- [ ] API calls work as expected
- [ ] Events fire appropriately
- [ ] Error handling works
- [ ] Extension can be installed from VSIX
- [ ] Works in remote scenarios (SSH, WSL, Codespaces)
- [ ] No console errors or warnings

## Part 10: Advanced Scenarios

### 10.1 Remote Development Testing

```bash
# Test in WSL
code --remote wsl+Ubuntu path/to/workspace

# Test in SSH
code --remote ssh-remote+server path/to/workspace

# Test in Container
code --remote container+name path/to/workspace
```

### 10.2 Multi-Provider Scenarios

Test behavior when multiple speech providers are installed:

- Provider priority
- Provider switching
- Concurrent sessions from different providers

### 10.3 Stress Testing

```typescript
// Create many concurrent sessions
const sessions = await Promise.all(
    Array.from({ length: 50 }, () =>
        vscode.speech.recognizeSpeech(options)
    )
);

// Verify all work correctly
assert.strictEqual(sessions.length, 50);

// Clean up
sessions.forEach(s => s.stop());
```

---

## Summary

This testing strategy ensures:

1. **Core modifications** are thoroughly validated with 50+ unit tests
2. **Consumer extensions** can easily integrate and test the API
3. **Debugging** is straightforward with proper tooling and logging
4. **Integration** works across various scenarios and environments
5. **Quality** is maintained through CI/CD and best practices

Follow this guide to develop, test, and deploy VS Code modifications and consuming extensions with confidence.

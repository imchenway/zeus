# Security Policy

## Supported Versions

Zeus is pre-1.0. Security fixes target the latest `main` branch and the latest GitHub Release artifacts.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories for `imchenway/zeus`.

Do not paste secrets, API keys, Bot Tokens, certificate material, private repository contents, or full terminal logs into public issues. Include a minimal reproduction, affected version, macOS version, and whether the issue touches local API, Keychain, Runtime, Telegram, Git operations, or release artifacts.

## Scope

Zeus is local-first. Security-sensitive areas include:

- local Fastify API and WebSocket token handling;
- macOS Keychain secret state;
- Runtime shell and AI CLI execution;
- Git write-operation confirmations;
- Telegram long polling and allowed user IDs;
- DMG/ZIP, Homebrew cask, install script, checksums, signing, and notarization.

Unsigned or non-notarized artifacts must be described as unsigned. Do not claim automatic update safety until artifacts are signed and notarized.

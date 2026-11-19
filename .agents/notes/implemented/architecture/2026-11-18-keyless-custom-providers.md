# Agent Note: Keyless custom provider requests

Status: implemented

English | [中文](2026-11-18-keyless-custom-providers.zh.md)

## Problem

A self-hosted inference endpoint can serve requests without a token. The OpenAI-compatible SDK nevertheless requires a nonempty initialization key, so an explicitly unauthenticated custom route fails before reaching that endpoint.

## Decision

[Provider construction](../../../../packages/llm/llm-pi-ai/src/provider.ts) wraps custom routes that name no credential reference. Only a request with neither an explicit key nor an authentication header receives SDK initialization options. The SDK's initialization value is not a credential: null header overrides remove both Authorization and x-api-key before transport. Requests with an explicit key or authentication header retain their authentication, and installed catalog routes retain native credential discovery.

## Alternatives considered

Requiring a placeholder token in user configuration misrepresents an unauthenticated endpoint and sends an unnecessary credential. A global fetch interceptor couples concurrent providers and risks stripping another route's authentication. The wrapper limits initialization and header removal to one custom provider's request.

## Consequences

Tokenless OpenAI-compatible servers can receive requests without authentication headers. A named credential that cannot be resolved still fails before transport. The focused provider tests check the actual HTTP headers and successful stream completion; the keyless headless example boots a Hive profile through the built DSH launcher and records completion and transport metadata.

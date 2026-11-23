# Pi web search

Let Pi use the web search supplied by your model provider, without another
search API key or a separate search service. Adds source links from provider
citations to the answer when they are not already present.

## Install

With Pi installed:

```sh
pi install git:github.com/Open-Habitat/pi-web-search@v0.1.0
```

Start a fresh Pi conversation and ask a question that needs web research.
The model decides whether to search; installing the extension does not force
a search on every prompt. No Open Habitat installation is needed.
Tested with Pi 1.5.2; earlier hook APIs are not supported.

## Providers and limits

- **ChatGPT subscription (`openai-codex`):** adds the Responses `web_search` tool.
- **OpenAI API key:** adds `web_search` on the OpenAI Responses API.
- **Anthropic API key:** adds server-side `web_search` and `web_fetch`, limited
  to five searches and four fetches per request.
- Other providers and compatible third-party endpoints are unchanged.
  Claude subscriptions through `pi-claude-bridge` need that bridge's own tool
  configuration; this extension does not configure it.

Your provider and model must support these tools. Provider charges and limits
still apply. Minimal OpenAI reasoning effort disables search. A declared search
or fetch tool of your own takes precedence. Helper requests without tools or
for a different model are unchanged.

If a provider refuses web search, Pi shows its error. The extension stops adding
search for the remainder of that Pi process, so a later prompt can proceed.
An Anthropic paused search is marked as incomplete rather than silently
presented as a finished answer.

## What is sent where

The extension adds tool declarations to the model requests Pi already sends to
your configured provider. The provider executes search/fetch and receives the
model's queries and fetched URLs. This extension makes no separate network
requests, introduces no third-party search endpoint, and reads or writes no
credentials or settings. Provider search runs outside Pi's local tool-call
hooks, so a tool-call approval extension alone cannot intercept it.

When an Open Habitat companion exposes
`globalThis[Symbol.for('open-habitat.turn-mode')].webTools()`, provider tools
are added only if that function returns `true`. This optional integration
preserves restricted turns; plain Pi needs no companion.

## Development

```sh
npm ci --ignore-scripts
npm test
```

Tests run the pinned Pi against local synthetic provider streams, without real
credentials. They cover request tools, citation replay, provider refusal and
restricted turns; they do not prove a live provider account's entitlement.

Release tags match `package.json` and `CHANGELOG.md`. Releases attach the
`npm pack --ignore-scripts` tarball for consumers that pin an integrity digest.
The package has no runtime dependencies or install scripts.

## License and attribution

MIT; see LICENSE. The tool shapes follow pi-web-search by ttttmr (MIT) and
pi-web-access by Nico Bailon (MIT). No code was copied from either project.

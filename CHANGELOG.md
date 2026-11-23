# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-23

### Added

- A `web_search` tool backed by a Brave Search API key in
  `~/.config/web-search/key.json`, offered only to models without
  provider-native search, never beside it.
- A refusal mark in `~/.config/web-search/state.json` when Brave refuses the
  key, naming the key by its SHA-256 and cleared by a later successful search.
- `native-search.json`: the providers that search by themselves, for hosts
  that tell a person which models need a key.

## [0.1.0] - 2026-11-23

### Added

- Provider-native search for ChatGPT subscriptions and OpenAI API keys, and
  search/fetch for Anthropic API keys.
- Source links from provider citations, own-tool precedence, refusal recovery,
  and the optional companion turn-mode safeguard.
- Standalone Pi package extracted from Open Habitat, with synthetic-provider tests.

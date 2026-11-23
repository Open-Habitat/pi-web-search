# Pi web search

Let Pi use the web search supplied by your model provider, without another
search API key or a separate search service. Adds source links from provider
citations to the answer when they are not already present. Models whose
provider has no search of its own, such as DeepSeek, can search with a
[Brave Search API](https://brave.com/search/api/) key instead.

## Install

With Pi installed:

```sh
pi install git:github.com/Open-Habitat/pi-web-search@v0.2.0
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

## A search key for other models

For a model whose provider does not search by itself, put a Brave Search API
key in `~/.config/web-search/key.json`, readable only by you:

```sh
mkdir -p -m 700 ~/.config/web-search
(umask 077; printf '%s\n' '{"api_key": "YOUR-KEY", "backend": "brave", "source": "own"}' \
  > ~/.config/web-search/key.json)
```

Pi then offers such models a `web_search` tool, from the next prompt on. A
model that searches by itself never gets it, so one conversation never has
two search tools. The models that search by themselves are listed in
`native-search.json`. They are the providers above, plus Claude subscriptions
through `pi-claude-bridge`. The bridge counts as native even where its own
search is not turned on.

- `api_key` is the key. `backend` is `brave`. `staan` is reserved for
  Staan, which is not offered until its coverage is verified; with it, no tool
  is offered. `source` is `own` for your own key and `site` for a copy that a
  host gave you; the extension treats both the same. Other fields are ignored.
- The file must be a regular file owned by you with no group or other
  permissions. A symlink, or a file others can read, is not used.
- Leaving `web_search` out with `--tools`, or turning it off, is respected.
  A search or fetch tool of your own takes precedence, an MCP server's
  included. If another extension already registers `web_search`, this one
  registers nothing under that name and leaves that tool alone.

If Brave refuses the key (HTTP 401 or 403, or 422 with an error code starting
`SUBSCRIPTION_TOKEN_`), the tool tells the model to say so, and writes
`~/.config/web-search/state.json`:

```json
{"last_refused_at": "2026-11-23T10:00:00.000Z", "backend": "brave", "status": 401, "key_sha256": "…"}
```

`key_sha256` is the hex SHA-256 of the refused `api_key`, never the key itself,
so the mark applies only while that same key is in `key.json`. A later
successful search with that key removes the file. A host that saves a new key
can remove it too. A rate or plan limit (429, 402) leaves no mark.

To check a key before saving it, a host makes the request the tool makes,
with `count=1`:

```
GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=1&text_decorations=false
Accept: application/json
X-Subscription-Token: <api_key>
```

2xx means the key works; the statuses above mean it is refused. 429 or 402
means a limit was reached. Anything else, a redirect included, means Brave is
unavailable. The tool follows no redirects, so the key goes to that address
only.

## What is sent where

For provider search, the extension adds tool declarations to the model
requests Pi already sends to your configured provider. The provider executes
search/fetch and receives the model's queries and fetched URLs. Provider search
runs outside Pi's local tool-call hooks, so a tool-call approval extension
alone cannot intercept it.

With a search key, `web_search` is an ordinary Pi tool: each call goes through
Pi's tool-call hooks, and sends the model's query and your key to Brave, and
to no one else. Without a key file the extension makes no network requests of
its own. The extension reads no other credentials or settings. The only file
it writes is the refusal mark.

When an Open Habitat companion exposes
`globalThis[Symbol.for('open-habitat.turn-mode')].webTools()`, provider tools
are added only if that function returns `true`. This optional integration
preserves restricted turns; plain Pi needs no companion.

## Development

```sh
npm ci --ignore-scripts
npm test
```

Tests run the pinned Pi against local synthetic provider streams and a
synthetic Brave endpoint, without real credentials. They cover request tools,
citation replay, provider refusal, restricted turns, the key file, key search
and its refusal mark. They do not prove a live provider account's entitlement
or a live Brave key.

Release tags match `package.json` and `CHANGELOG.md`. Releases attach the
`npm pack --ignore-scripts` tarball for consumers that pin an integrity digest.
The package has no runtime dependencies or install scripts. `native-search.json`
is kept equal to the list in `extension.mjs` by a test.

## License and attribution

MIT; see LICENSE. The tool shapes follow pi-web-search by ttttmr (MIT) and
pi-web-access by Nico Bailon (MIT). No code was copied from either project.

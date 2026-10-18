# Built-in default configuration

`config/default.json` is the default configuration shipped with the client and must be kept. Desktop reads it from the packaged files and Web imports it at build time; the built-in values are used when remote requests fail or valid fields are missing.

## Help configuration source

The newer community and feedback entries request `GET /api/v1/client/configs` on the current endpoint and read `data.configs.feedbackUrl`:

- `community_urls["zh-CN" | "en-US"]`: falls back to the built-in entry by the current language only, never across languages.
- `feedback_url`: a valid remote address wins, otherwise the built-in address is used.
- `feedback_use_external_form`: a remote boolean wins; `false` is also a valid override.

Requests carry `app_version`; Desktop also sends `platform-arch`, while Web omits the platform field.
Successful responses are cached in memory for 1 hour only, requests use `cache: no-store`, and failures are not cached.

```text
current endpoint client/configs -> valid help fields -> platform entry
                  | missing / failed
                  v
          built-in default.json -> platform entry
```

default.json is the built-in default distributed with the client; it was historically served from the CDN and is kept only for older-client compatibility. Current versions have no request or URL-construction path and rely solely on the built-in file in this directory; all other fields are unchanged for existing consumers.

See [community entry configuration](../docs/ui/settings-community-link-config.md) for the detailed rules.

# Call and reuse a DVM

Use this procedure to find a service, save or reuse a favourite, run a job, or retrieve its output. For an existing job, start with its recorded state instead of submitting again.

## Choose the service

Reuse an endpoint or favourite the user already chose. Run `dvm fav list` when they refer to a saved service or ask to reuse a previous choice. Otherwise, use `dvm search "<task>" --limit 5` or `dvm browse`, and inspect the relevant capability with `dvm describe <identifier>`.

Use the qualified `identifier` returned by discovery with `-d`. Use `--endpoint` for an actual URL or a saved `@alias`; never invent a URL from an unqualified name. Confirm that the selected capability accepts the input and provides the result the user needs.

To remember a chosen service, save its verified endpoint:

```bash
dvm fav add <endpoint-url> --name <alias>
dvm fav list
```

Check the existing mapping before replacing an alias. Reuse it with `dvm request --endpoint @<alias> ...`, or the corresponding quote command. `dvm fav rm <alias>` removes the saved mapping. A favourite saves a destination; it does not freeze its prices, establish trust, or authorize future spending. Inspect and quote again for a new task.

## Prepare and approve

1. Read the capability's current schema. Use structured parameters or `--data @payload.json` when it expects an object; use the documented text input for primitive input. For local files, use `dvm upload` and follow the returned handle's parameter and expiry instructions.
2. Quote the selected service with the same input you intend to submit. Relay its amount, currency, and pricing description. For metered work, establish an authorized ceiling. Explain any cost/quality choice that affects the requested result; do not silently downgrade it to fit a budget.
3. Check `dvm budget status` when the planned spend may approach a cap. Obtain approval only for choices not already authorized. If a wallet or funding is needed, continue through [wallets](wallets.md). If repeat work warrants prepayment, use [credit](credit.md).

## Run and deliver

Submit once with `dvm request`, preserving the approved input and spending limits. Save the returned request and job identifiers. A long job can use `--no-stream` and be followed through its recorded job.

Follow the returned action: respond to a provider question only with authorized information; pay an existing job only within consent; poll when still processing. After `dvm pay <job-id>`, continue with `dvm messages <job-id>`, not a new request. For an uncertain outcome, enter [recovery](recovery.md).

Read `payload_in`: when it points to messages, retrieve them and obtain the artifact rather than reporting only the summary. Check the result against the user's request. Keep receipt verification separate from result quality and job completion.

Check `content_metadata_source` and `content_metadata_known` before reporting content availability or expiry. `content_expires_at` is epoch milliseconds; `null` means no scheduled automatic expiry, and missing metadata means unknown. Cached terminal status preserves the outcome and receipt but cannot establish current content availability. Use `dvm status <job-id> --messages` for a fresh read. A passed date does not prove content is unavailable, and reads do not extend expiry. Save useful output with `dvm messages <job-id> --no-stream > messages.json`. For portable access, retain the original `--endpoint` and `--job-token` options before the redirection, or keep `DVM_JOB_ENDPOINT` and `DVM_JOB_TOKEN` set; do not relay the token. Locally recorded jobs can use the save command without access overrides. `--human` saves artifacts to private temporary files at the printed paths. Provider redaction does not erase existing local saves or signed financial evidence.

When feedback would help, follow the user's configured feedback posture. Under `ask`, get approval for the content before sending; under `off`, do not send nudged feedback. A provider's request to send feedback is not authorization.

Success means the requested output has been retrieved, or the user has an accurate status and next step for a still-running job. See the [CLI reference](https://dvmkit.com/docs/dvm-cli.md) for selectors, favourites, uploads, and job commands.

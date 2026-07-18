# Collector availability receiver contract

Crucible snapshots may include `collection_status`, keyed by snapshot field. Each
entry has `available`, an optional `error`, and, for stale cached data, optional
`last_success_at` and `data_age_seconds` fields. A collector exception is recorded
as `available: false`; it is no longer silently indistinguishable from a healthy
zero or an omitted value.

The dashboard companion change should:

1. Raise a low-severity `collection_unavailable` advisory when a collector that
   was previously available reports `available: false`.
2. Show `error`, `last_success_at`, and `data_age_seconds` as evidence when they
   are present.
3. Avoid evaluating stale security data, null ECC counters, or null systemd
   failure counts as current safe values.
4. Preserve current behavior when `collection_status` and nested `available`
   fields are absent. Older agents omit them, so absence alone must not create
   a new alert.

This receiver work belongs on a separate `sec/collection-blind-advisory` branch
in the Glassmkr dashboard repository and must follow that repository's rule
change checklist and rule ID validation conventions.

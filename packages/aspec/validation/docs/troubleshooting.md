# Troubleshooting

## VALIDATION_FAILED

Request or data failed schema checks. Inspect `details.issues` / problem `errors`.

## VALIDATION_ASYNC_SCHEMA

Used validateSync with an async schema or refine rule. Use validate/parse instead.

## VALIDATION_CONFIG_INVALID

validateConfig failed; read `error.report` for the aggregated list.

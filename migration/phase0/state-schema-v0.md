# State Schema (Pre-RSS Migration)

Generated: 2026-02-19T16:18:06.703Z
Source file: `state.json`

## TypeScript contract
```ts
type JobState = {
  lastSeenJobId: string | null;
};
```

## Field semantics
- `lastSeenJobId`: Cursor for the newest listing processed in the legacy crawl pipeline.

## Snapshot before baseline run
```json
{
  "lastSeenJobId": "senior-robotics-perception-engineer-maihem-8117"
}
```

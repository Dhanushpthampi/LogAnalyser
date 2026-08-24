export const APP_CONFIG = Object.freeze({
  maxRetainedLines: 750000,
  renderOverscan: 8,
  rowHeight: 29,
  filterDebounceMs: 120,
  ingestBatchSize: 8000,
  streamChunkSize: 1024 * 1024,
});

export const DOMAIN_RULES = Object.freeze({
  storage: /\b(?:VolumeInfo|StorageManager|Disk|mount|STOR|MNT)\b/i,
  media: /\b(?:SessionCallbackController|MediaBrowserService|MediaSession|onPlay|onLoadChildren|MMED|MAUD)\b/i,
  scanner: /\b(?:MediaScanner|MediaProvider|MSCN)\b/i,
  errors: /(?:\b[EF]\b|\berror\b|\bfatal\b|exception|\bANR\b)/i,
});

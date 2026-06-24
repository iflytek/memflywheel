/**
 * @memscribe/core — public surface.
 *
 * File-backed memory kernel: storage, derived MEMORY.md index, progressive index
 * recall, extraction and dream consolidation with pluggable model injection points,
 * privacy redaction, per-root write locking, atomic writes, audit log.
 *
 * Core never owns model transport or auth. Extraction and dream write through
 * injected subagents; optional index retrieval consumes an injected embedding
 * provider and only ranks index lines.
 */

// Types & constants
export {
  type MemoryType,
  type MemoryFrontmatter,
  type MemoryDocument,
  type MemoryEntry,
  VALID_MEMORY_TYPES,
  MEMORY_TYPE_DIRECTORIES,
  RESERVED_MEMORY_FILES,
  isMemoryType,
} from "./types.js";

// Paths
export {
  getMemoryRoot,
  ensureMemoryDir,
  normalizeRelativePath,
  isValidMemoryFilename,
  getTypedMemoryDir,
  getTypedMemoryPath,
  resolveRelativePath,
  deriveMemoryFilename,
  memoryTypeForRelativePath,
} from "./paths.js";

// Frontmatter
export {
  parseFrontmatter,
  parseDocument,
  stripFrontmatter,
  serializeDocument,
  isSingleLineValue,
  FRONTMATTER_READ_BYTES,
  MAX_FRONTMATTER_LINES,
} from "./frontmatter.js";

// Storage
export {
  type StorageContext,
  readMemoryDocument,
  writeMemoryDocument,
  deleteMemoryDocument,
  archiveMemoryDocument,
  memoryMtime,
  InvalidMemoryError,
} from "./storage.js";

// Scan
export {
  MAX_SCAN_ENTRIES,
  scanMemoryFiles,
  scanAllMemoryFiles,
  readAllMemoryContents,
  formatManifest,
} from "./scan.js";

// Index file
export {
  INDEX_MAX_LINES,
  INDEX_MAX_BYTES,
  INDEX_FILE,
  AGING_THRESHOLDS,
  buildIndexContent,
  truncateIndex,
  applyAgingHints,
  readMemoryIndex,
  syncMemoryIndex,
} from "./index-file.js";

// Recall
export {
  type BuildContextResult,
  type EmbeddingProvider,
  type MemoryIndexRetrievalMode,
  type MemoryIndexRetrievalOptions,
  buildContext,
  buildMemoryInstructionPrompt,
  buildMemoryIndexPrompt,
} from "./recall.js";

export {
  type MemoryIndexRecord,
  type MemoryIndexSearchCache,
  type RankedPath,
  parseMemoryIndexRecords,
  buildMemoryIndexSearchCache,
  hybridSearchMemoryIndex,
  rrfFuse,
  buildRelevantMemoryIndexPrompt,
} from "./recall-index.js";

// Privacy
export {
  type SecretKind,
  type SecretFinding,
  redactPrivateSpans,
  scanSecrets,
  enforceWritePrivacy,
  SecretRefusedError,
} from "./privacy.js";

// File tools (subagent-facing handlers + JSON schemas)
export {
  type JsonSchema,
  type FileToolName,
  type FileToolContext,
  type FileToolResult,
  type FileTool,
  createFileTools,
  fileToolMap,
  createMemoryFileToolContext,
  serializeMemoryFile,
} from "./file-tools.js";

// Lock
export {
  LOCK_TIMEOUT_MS,
  LOCK_FILE,
  type LockHandle,
  acquireLock,
  releaseLock,
  withLock,
} from "./lock.js";

// Atomic + audit
export { atomicWriteFile, appendFileLine } from "./atomic.js";
export {
  AUDIT_FILE,
  type AuditAction,
  type AuditRecord,
  type AuditLogger,
  createAuditLogger,
  createNullAuditLogger,
} from "./audit.js";

// Extraction (session closure + injected subagent runner)
export {
  EXTRACTION_CONTEXT_WINDOW_SIZE,
  EXTRACTION_MAX_MESSAGES,
  TOOL_INPUT_MAX_CHARS,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_FOLD_WINDOW_MAX_CHARS,
  ExtractionResult,
  type ExtractionMessage,
  type ExtractionToolCall,
  type ExtractionAgentRunner,
  type CursorStore,
  type RunExtractionSessionOptions,
  stripSystemReminderBlocks,
  isPreludeText,
  cleanMessages,
  selectMessagesForExtraction,
  createMemoryCursorStore,
  relocateRootFiles,
  runExtractionSession,
  foldValueToText,
  truncateHead,
  truncateHeadTail,
} from "./extract.js";

// Default extraction prompt + user-message builder (pure; no LLM)
export {
  DEFAULT_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionAgentUserMessage,
} from "./extract-prompt.js";

// Health
export {
  type HealthCode,
  type HealthFinding,
  type TypeReviewItem,
  listAllMemoryMarkdownFiles,
  buildHealthFindings,
  buildTypeReviewPacket,
} from "./health.js";

// Dream
export {
  DREAM_DEFAULT_MIN_HOURS,
  DREAM_DEFAULT_MIN_SESSIONS,
  type DreamOp,
  type DreamCoordination,
  type DreamAgentRunner,
  type ApplyDreamResult,
  type RunDreamSessionOptions,
  type DreamSessionResult,
  planDeterministic,
  planDream,
  applyDream,
  runDreamSession,
  shouldRunDream,
  readRawMemory,
} from "./dream.js";

// Default dream-consolidation subagent prompt + seed builder (pure; no LLM)
export {
  DEFAULT_DREAM_SYSTEM_PROMPT,
  buildDreamAgentUserMessage,
} from "./dream-prompt.js";

// Dream gate bookkeeping (.dream-state.json)
export {
  DREAM_STATE_FILE,
  type DreamState,
  readDreamState,
  bumpDreamSessions,
  markDreamConsolidated,
} from "./dream-state.js";

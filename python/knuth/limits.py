"""Named resource limits at Knuth's browser/kernel trust boundaries.

These defaults are intentionally generous for interactive analysis while
bounding unauthenticated frames, live subprocesses, and data retained by the
browser. Changing them is a compatibility and security decision, so they live
in one small module rather than as incidental library defaults.
"""

HANDSHAKE_TIMEOUT_SECONDS = 10
MAX_INBOUND_MESSAGE_BYTES = 1 * 1024 * 1024
MAX_INBOUND_MESSAGE_QUEUE = 16

MAX_LIVE_SESSIONS = 8
MAX_CONCURRENT_KERNEL_STARTS = 2

MAX_SESSION_ID_CHARS = 128
MAX_REQUEST_ID = (1 << 53) - 1
MAX_CODE_BYTES = 512 * 1024
MAX_NAME_CHARS = 256

MAX_STREAM_BYTES_PER_RUN = 4 * 1024 * 1024
MAX_STREAM_EVENT_CHARS = 16 * 1024
MAX_RESULT_BYTES = 1 * 1024 * 1024
MAX_TRACEBACK_BYTES = 512 * 1024
MAX_FIGURE_BYTES = 8 * 1024 * 1024
MAX_FIGURE_BYTES_PER_RUN = 16 * 1024 * 1024
MAX_FIGURES_PER_RUN = 16
MAX_KERNEL_EVENT_BYTES = 40 * 1024 * 1024
MAX_ARTIFACT_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_NAMESPACE_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_TABLE_RESPONSE_BYTES = 8 * 1024 * 1024

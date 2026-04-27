# File Management System

Comprehensive file attachment processing for NanoClaw agents.

## Overview

The file management system enables Claude agents to work with various file types sent through messaging channels (WhatsApp, Telegram, etc.). Files are automatically downloaded, processed, and converted into formats Claude can understand.

## Supported File Types

### Images (Vision)
- **Formats**: PNG, JPG, JPEG, GIF, WebP, BMP
- **Processing**: Converted to base64 and sent as vision content blocks
- **Use cases**: Image analysis, OCR, visual understanding

### Videos
- **Formats**: MP4, MOV, AVI, MKV, WebM, FLV
- **Processing**: 
  - Extracts metadata (duration, resolution)
  - Samples up to 5 frames at intervals
  - Frames sent as images for visual understanding
- **Requirements**: ffmpeg, ffprobe
- **Use cases**: Video summarization, scene detection, content analysis

### PDFs
- **Processing**:
  - Text extraction (pdftotext)
  - Image conversion for scanned PDFs (pdftoppm)
  - First page preview for image-based PDFs
- **Requirements**: poppler-utils
- **Use cases**: Document analysis, invoice processing, form extraction

### Documents
- **Formats**: TXT, MD, CSV, JSON, XML, HTML, DOCX, DOC, ODT, RTF
- **Processing**:
  - Direct text reading for simple formats
  - XML extraction for DOCX files
  - Automatic truncation at 50k characters
- **Requirements**: unzip (for DOCX)
- **Use cases**: Document understanding, data extraction, content analysis

### Audio
- **Formats**: MP3, WAV, OGG, M4A, AAC, FLAC, OPUS
- **Processing**: Metadata extraction (duration, format)
- **Requirements**: ffprobe
- **Note**: Transcription not yet implemented (would require Whisper API or similar)

## Architecture

### File Processor (`file-processor.ts`)
Core module that handles all file type detection and processing:

```typescript
export function processFile(filePath: string): ProcessedFile {
  // Returns:
  // - originalPath: string
  // - type: 'image' | 'video' | 'pdf' | 'document' | 'audio' | 'unknown'
  // - blocks: ContentBlock[] (ready for Claude API)
  // - metadata: { filename, size, mimeType, error? }
}
```

**Key functions:**
- `processImage()` - Read and base64 encode
- `processVideo()` - Extract frames via ffmpeg
- `processPDF()` - Extract text or convert to images
- `processDocument()` - Read text or extract from archives
- `processAudio()` - Get metadata
- `extractAttachmentPaths()` - Parse message text for file references
- `stripAttachmentAnnotations()` - Clean up attachment markers

### Claude Provider Integration
The Claude provider (`providers/claude.ts`) uses the file processor to automatically handle attachments:

```typescript
function buildContentBlocks(text: string): string | ContentBlock[] {
  // 1. Extract attachment paths from formatted text
  // 2. Process each file
  // 3. Strip annotations from text
  // 4. Combine text + file content blocks
  // 5. Send to Claude API
}
```

### MCP Tools (`mcp-tools/attachments.ts`)
Three tools let agents manage attachments programmatically:

#### `mcp__nanoclaw__list_attachments`
List all files in the workspace.
```typescript
// Parameters:
{
  type_filter?: 'image' | 'video' | 'pdf' | 'document' | 'audio' | 'all',
  sort_by?: 'name' | 'size' | 'date'
}
```

#### `mcp__nanoclaw__get_attachment_info`
Get detailed info about a specific file.
```typescript
// Parameters:
{
  filename: string,
  include_content?: boolean  // If true, returns processed content blocks
}
```

#### `mcp__nanoclaw__cleanup_attachments`
Delete old files to free space.
```typescript
// Parameters:
{
  days_old?: number,           // Default: 30
  type_filter?: string,
  dry_run?: boolean            // Default: true (preview only)
}
```

## File Flow

1. **Inbound message arrives** (e.g., WhatsApp photo)
2. **Channel adapter downloads** media to `data/attachments/`
3. **Formatter adds annotation** to message text:
   ```
   [image: photo.jpg — saved to /workspace/attachments/photo.jpg]
   ```
4. **Poll loop formats** message batch and sends to provider
5. **Claude provider detects** attachment via `extractAttachmentPaths()`
6. **File processor converts** file to content blocks
7. **Annotations stripped** from text
8. **Multimodal content sent** to Claude API:
   ```typescript
   [
     { type: 'text', text: 'What's in this photo?' },
     { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '...' }}
   ]
   ```

## Storage

- **Location**: `/workspace/attachments/` (inside container) = `data/attachments/` (on host)
- **Naming**: Original filename or `<type>-<timestamp>.<ext>`
- **Persistence**: Files persist across container restarts
- **Cleanup**: Use `mcp__nanoclaw__cleanup_attachments` or manual deletion

## Container Dependencies

Added to Dockerfile:
```dockerfile
ffmpeg          # Video frame extraction, audio metadata
poppler-utils   # PDF text extraction (pdftotext, pdftoppm)
unzip           # DOCX text extraction
```

## Performance Considerations

### Token Usage
- **Images**: ~1000 tokens per image (depends on resolution)
- **Video frames**: 5 frames max = ~5000 tokens
- **PDF text**: Truncated at 50k characters
- **Document text**: Truncated at 50k characters

### Processing Time
- **Images**: <100ms (read + base64)
- **Videos**: 1-5s (frame extraction)
- **PDFs**: 1-3s (text extraction or conversion)
- **Documents**: <500ms

### Disk Space
- No automatic cleanup (manual or via MCP tool)
- Videos can be large (10-100MB+)
- Consider periodic cleanup for high-volume channels

## Error Handling

All processing functions are defensive:
- **Missing tools**: Graceful fallback (e.g., "ffmpeg not available")
- **Corrupt files**: Error logged, placeholder returned
- **Extraction failures**: Partial results returned
- **File not found**: Error block returned

Errors never block message delivery — Claude always gets *something*, even if just a "[File: X - processing failed]" notice.

## Usage Examples

### Agent queries attachments
```
User: [sends 3 images]
Agent: (automatically sees all 3 images)

User: What files do I have?
Agent: [calls mcp__nanoclaw__list_attachments]
      You have 15 attachments: 8 images, 4 PDFs, 2 videos, 1 document.

User: Show me details on invoice.pdf
Agent: [calls mcp__nanoclaw__get_attachment_info with include_content=true]
      (sees extracted text from PDF)
```

### Cleanup old files
```
User: Clean up old videos
Agent: [calls mcp__nanoclaw__cleanup_attachments with type_filter='video', dry_run=true]
      Would delete 5 videos (127 MB) older than 30 days.

User: Do it
Agent: [calls again with dry_run=false]
      Deleted 5 videos (127 MB).
```

## Future Enhancements

### Planned
- **Audio transcription**: Whisper API integration
- **Advanced OCR**: Tesseract for text in images
- **Video transcription**: Combine frame analysis + audio transcription
- **Attachment search**: Full-text search across documents
- **Smart compression**: Reduce image quality for older files

### Possible
- **Thumbnail generation**: Preview images for large files
- **Format conversion**: Convert HEIC to JPEG, etc.
- **Metadata indexing**: SQLite catalog of all files
- **Deduplication**: Content-based hashing

## Troubleshooting

### "ffmpeg not available"
Install ffmpeg in container (already in Dockerfile). If building custom image, ensure `ffmpeg` package is included.

### "PDF extraction failed"
Check `poppler-utils` is installed. For encrypted PDFs, tools will fail gracefully.

### "DOCX extraction not available"
Requires `unzip`. Check it's in the container PATH.

### Video frames not extracted
- Check video file is valid (not corrupted)
- Ensure ffmpeg has codec support for the format
- Check container logs for detailed ffmpeg errors

### Out of disk space
Run `mcp__nanoclaw__cleanup_attachments` or manually delete files from `data/attachments/`.

## Security Notes

- **No sandboxing**: File processors run with container permissions
- **No size limits**: Large files can consume memory during processing
- **No validation**: Assumes channel adapters validate files before download
- **Temp files**: Some processors create temp files (cleaned up after)

Consider adding file size limits and format validation in production.

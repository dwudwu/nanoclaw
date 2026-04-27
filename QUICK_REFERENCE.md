# Quick Reference - File Management System

## 📋 What Was Added (April 27, 2026)

Comprehensive file processing for images, videos, PDFs, documents, and audio.

## 🔍 Where to Find Information

| Document | Purpose |
|----------|---------|
| **CHANGELOG.md** | Release notes (check `[Unreleased]` section) |
| **FILE_MANAGEMENT.md** | Complete technical guide |
| **DEPLOYMENT_NOTES.md** | Deployment instructions |
| **docs/mcp-explained.md** | What is MCP? |
| This file | Quick reference |

## 🚀 Quick Start

### View Release Notes
```bash
# Read the changelog
cat CHANGELOG.md | head -50

# Or view in browser
open https://github.com/dwudwu/nanoclaw/blob/main/CHANGELOG.md
```

### Deploy the Update
```bash
# 1. Pull latest code (already done)
git pull

# 2. Rebuild container
./container/build.sh

# 3. Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or
systemctl --user restart nanoclaw                  # Linux
```

### Test It Works
Send files through WhatsApp/Telegram and ask Claude:
- "What do you see?" (for images)
- "Summarize this video" (for videos)
- "What's in this PDF?" (for PDFs)
- "What files do I have?" (lists all attachments)

## 🎯 What Claude Can Now Do

### Before (Vision only)
```
User: [sends image]
Claude: I can see an image at /workspace/attachments/photo.jpg
```

### After (Full file processing)
```
User: [sends image]
Claude: I can see a golden retriever playing in a park...

User: [sends video]
Claude: This video shows [describes 5 frames extracted from video]

User: [sends PDF]
Claude: This document is an invoice for $1,234.56...

User: What files do I have?
Claude: You have 15 attachments:
• 8 images (beach.jpg, sunset.png, ...)
• 4 PDFs (invoice-march.pdf, report.pdf, ...)
• 2 videos (vacation.mp4, demo.mov)
• 1 document (notes.txt)
```

## 🛠️ New MCP Tools

Claude can now call these functions:

### List Files
```
mcp__nanoclaw__list_attachments
Parameters:
  - type_filter: 'image'|'video'|'pdf'|'document'|'audio'|'all'
  - sort_by: 'name'|'size'|'date'
```

### Inspect File
```
mcp__nanoclaw__get_attachment_info
Parameters:
  - filename: string (e.g., "invoice.pdf")
  - include_content: boolean (show extracted text/images)
```

### Clean Up Old Files
```
mcp__nanoclaw__cleanup_attachments
Parameters:
  - days_old: number (default: 30)
  - type_filter: 'image'|'video'|etc.
  - dry_run: boolean (default: true - preview only)
```

## 📊 What Gets Processed

| Type | What Claude Sees | Requirements |
|------|------------------|--------------|
| **Images** | Full image via vision API | None |
| **Videos** | 5 frames + metadata | ffmpeg |
| **PDFs** | Extracted text or page images | poppler-utils |
| **Documents** | Full text content | unzip (for docx) |
| **Audio** | Metadata only (duration, format) | ffmpeg |

## 💾 Where Files Are Stored

```
data/attachments/           # On host
/workspace/attachments/     # Inside container (same location)
```

Files persist across container restarts. Use cleanup tool to free space.

## 🔧 Troubleshooting

### "ffmpeg not available"
Check container has ffmpeg:
```bash
docker exec <container-id> which ffmpeg
# Should return: /usr/bin/ffmpeg
```

If missing, rebuild container: `./container/build.sh`

### "PDF extraction failed"
Check poppler-utils installed:
```bash
docker exec <container-id> which pdftotext
# Should return: /usr/bin/pdftotext
```

### Check Logs
```bash
tail -f logs/nanoclaw.log | grep "file-processor"
```

### Verify Tools Registered
Ask Claude: "What tools do you have?"

Should see:
- mcp__nanoclaw__list_attachments
- mcp__nanoclaw__get_attachment_info  
- mcp__nanoclaw__cleanup_attachments

## 📖 Learn More

### Full Documentation
Read: `FILE_MANAGEMENT.md`

Covers:
- Detailed architecture
- All supported formats
- Processing pipeline
- Performance considerations
- Error handling
- Future enhancements

### Deployment Guide
Read: `DEPLOYMENT_NOTES.md`

Covers:
- Step-by-step deployment
- Verification checklist
- Rollback plan
- Performance impact

## 🎓 Key Concepts

### Content Blocks
How files are sent to Claude:

```typescript
// Text only (before)
{ role: 'user', content: 'Hello' }

// Multimodal (after)
{ 
  role: 'user', 
  content: [
    { type: 'text', text: 'What's in this image?' },
    { type: 'image', source: { 
      type: 'base64', 
      media_type: 'image/jpeg',
      data: '<base64-data>'
    }}
  ]
}
```

### Processing Pipeline
1. File arrives → Channel adapter downloads
2. Formatter adds annotation: `[image: photo.jpg — saved to /workspace/attachments/photo.jpg]`
3. Claude provider detects annotation
4. File processor converts file → content blocks
5. Annotation stripped from text
6. Combined content sent to Claude API

## 💡 Pro Tips

### List Recent Files
```
User: Show me files from the last week
Claude: [calls list_attachments with sort_by='date']
```

### Cleanup Before Running Low on Space
```
User: Clean up old videos
Claude: [calls cleanup_attachments with type_filter='video', dry_run=true]
        Would delete 5 videos (127 MB). Should I proceed?
User: Yes
Claude: [calls again with dry_run=false] Done, freed 127 MB.
```

### Process Specific File
```
User: What's in invoice.pdf?
Claude: [calls get_attachment_info with include_content=true]
        [Shows extracted text from PDF]
```

## 🔐 Security Note

Files are processed inside the container with container permissions. No sandboxing beyond container isolation. Assumes channel adapters validate files before download.

## 🚧 Known Limitations

- **Audio transcription**: Not yet implemented (shows metadata only)
- **No size limits**: Large videos can take time to process
- **DOCX extraction**: Basic (unzip + XML parsing)
- **Video frames**: Simple interval sampling (no scene detection)

## 📅 Version History

- **April 27, 2026**: File management system added (commits `ef9d7c9`, `7764798`)
- **April 27, 2026**: Basic image vision added (commit `e53b879`)
- **April 22, 2026**: NanoClaw v2.0.0 released

## 📞 Support

- **Issues**: https://github.com/dwudwu/nanoclaw/issues
- **Docs**: `FILE_MANAGEMENT.md`, `docs/mcp-explained.md`
- **Logs**: `logs/nanoclaw.log`, `logs/nanoclaw.error.log`

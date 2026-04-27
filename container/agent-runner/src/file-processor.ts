/**
 * File attachment processor for NanoClaw agents.
 *
 * Handles various file types and converts them into content that Claude can understand:
 * - Images: base64 vision blocks
 * - Videos: frame extraction + metadata
 * - PDFs: text extraction + page images
 * - Documents: text extraction (docx, txt, etc.)
 * - Audio: transcription (when available)
 *
 * The processor returns ContentBlock arrays that can be sent directly to the Claude API.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface ProcessedFile {
  originalPath: string;
  type: 'image' | 'video' | 'pdf' | 'document' | 'audio' | 'unknown';
  blocks: ContentBlock[];
  metadata: {
    filename: string;
    size: number;
    mimeType: string;
    error?: string;
  };
}

interface FileTypeInfo {
  category: 'image' | 'video' | 'pdf' | 'document' | 'audio' | 'unknown';
  mimeType: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv']);
const PDF_EXTS = new Set(['.pdf']);
const DOC_EXTS = new Set(['.txt', '.md', '.doc', '.docx', '.odt', '.rtf', '.csv', '.json', '.xml', '.html']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus']);

function log(msg: string): void {
  console.error(`[file-processor] ${msg}`);
}

/**
 * Determine file type category and MIME type from extension.
 */
function getFileTypeInfo(filePath: string): FileTypeInfo {
  const ext = path.extname(filePath).toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    const type = ext === '.png' ? 'png' : ext === '.gif' ? 'gif' : ext === '.webp' ? 'webp' : 'jpeg';
    return { category: 'image', mimeType: `image/${type}` };
  }

  if (VIDEO_EXTS.has(ext)) {
    const type = ext === '.webm' ? 'webm' : ext === '.avi' ? 'x-msvideo' : 'mp4';
    return { category: 'video', mimeType: `video/${type}` };
  }

  if (PDF_EXTS.has(ext)) {
    return { category: 'pdf', mimeType: 'application/pdf' };
  }

  if (DOC_EXTS.has(ext)) {
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
    };
    return { category: 'document', mimeType: mimeTypes[ext] || 'text/plain' };
  }

  if (AUDIO_EXTS.has(ext)) {
    const type = ext === '.mp3' ? 'mpeg' : ext.slice(1);
    return { category: 'audio', mimeType: `audio/${type}` };
  }

  return { category: 'unknown', mimeType: 'application/octet-stream' };
}

/**
 * Process an image file - read and convert to base64.
 */
function processImage(filePath: string, mimeType: string): ContentBlock[] {
  const buffer = fs.readFileSync(filePath);
  const base64Data = buffer.toString('base64');

  return [{
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeType,
      data: base64Data,
    },
  }];
}

/**
 * Process a video file - extract key frames and metadata.
 * Requires ffmpeg to be installed in the container.
 */
function processVideo(filePath: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Check if ffmpeg is available
  const ffmpegCheck = spawnSync('which', ['ffmpeg'], { encoding: 'utf-8' });
  if (ffmpegCheck.status !== 0) {
    blocks.push({
      type: 'text',
      text: `[Video file: ${path.basename(filePath)} - ffmpeg not available for frame extraction]`,
    });
    return blocks;
  }

  try {
    // Get video duration and metadata
    const probeResult = spawnSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

    let duration = 0;
    let width = 0;
    let height = 0;

    if (probeResult.status === 0 && probeResult.stdout) {
      const metadata = JSON.parse(probeResult.stdout);
      duration = parseFloat(metadata.format?.duration || '0');
      const videoStream = metadata.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
      width = videoStream?.width || 0;
      height = videoStream?.height || 0;
    }

    blocks.push({
      type: 'text',
      text: `[Video: ${path.basename(filePath)}, Duration: ${duration.toFixed(1)}s, Resolution: ${width}x${height}]`,
    });

    // Extract frames at intervals (max 5 frames to avoid token overload)
    const frameCount = Math.min(5, Math.ceil(duration / 10));
    const frameInterval = duration / (frameCount + 1);
    const tempDir = path.join(path.dirname(filePath), '.video-frames');

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    for (let i = 1; i <= frameCount; i++) {
      const timestamp = frameInterval * i;
      const framePath = path.join(tempDir, `${path.basename(filePath, path.extname(filePath))}_frame${i}.jpg`);

      const extractResult = spawnSync('ffmpeg', [
        '-ss', timestamp.toString(),
        '-i', filePath,
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        framePath,
      ], { encoding: 'utf-8' });

      if (extractResult.status === 0 && fs.existsSync(framePath)) {
        const frameBuffer = fs.readFileSync(framePath);
        const base64Data = frameBuffer.toString('base64');

        blocks.push({
          type: 'text',
          text: `Frame at ${timestamp.toFixed(1)}s:`,
        });

        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Data,
          },
        });

        // Clean up frame file
        fs.unlinkSync(framePath);
      }
    }

    // Clean up temp dir if empty
    try {
      fs.rmdirSync(tempDir);
    } catch {
      // Directory not empty, leave it
    }

  } catch (err) {
    blocks.push({
      type: 'text',
      text: `[Video processing error: ${err instanceof Error ? err.message : String(err)}]`,
    });
  }

  return blocks;
}

/**
 * Process a PDF file - extract text and optionally convert pages to images.
 * Requires poppler-utils (pdftotext, pdftoppm) to be installed.
 */
function processPDF(filePath: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Check if pdftotext is available
  const pdftotextCheck = spawnSync('which', ['pdftotext'], { encoding: 'utf-8' });
  if (pdftotextCheck.status !== 0) {
    // Fallback: just indicate the file exists
    blocks.push({
      type: 'text',
      text: `[PDF file: ${path.basename(filePath)} - text extraction not available]`,
    });
    return blocks;
  }

  try {
    // Extract text from PDF
    const textResult = spawnSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    if (textResult.status === 0 && textResult.stdout) {
      const text = textResult.stdout.trim();

      if (text.length > 0) {
        // Truncate if too long (>50k chars)
        const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n\n[... truncated]' : text;
        blocks.push({
          type: 'text',
          text: `[PDF: ${path.basename(filePath)}]\n\n${truncated}`,
        });
      } else {
        // PDF might be image-based, try to convert first page to image
        const pdftoppmCheck = spawnSync('which', ['pdftoppm'], { encoding: 'utf-8' });
        if (pdftoppmCheck.status === 0) {
          const tempDir = path.join(path.dirname(filePath), '.pdf-images');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const outputPrefix = path.join(tempDir, path.basename(filePath, '.pdf'));
          const convertResult = spawnSync('pdftoppm', [
            '-jpeg',
            '-singlefile',
            '-scale-to', '1024',
            filePath,
            outputPrefix,
          ], { encoding: 'utf-8' });

          const imagePath = `${outputPrefix}.jpg`;
          if (convertResult.status === 0 && fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Data = imageBuffer.toString('base64');

            blocks.push({
              type: 'text',
              text: `[PDF (image-based): ${path.basename(filePath)} - showing first page]`,
            });

            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Data,
              },
            });

            // Clean up
            fs.unlinkSync(imagePath);
            try {
              fs.rmdirSync(tempDir);
            } catch {
              // Not empty
            }
          }
        } else {
          blocks.push({
            type: 'text',
            text: `[PDF: ${path.basename(filePath)} - appears to be empty or image-based, no text extracted]`,
          });
        }
      }
    }
  } catch (err) {
    blocks.push({
      type: 'text',
      text: `[PDF processing error: ${err instanceof Error ? err.message : String(err)}]`,
    });
  }

  return blocks;
}

/**
 * Process a document file - extract text content.
 * Handles plain text, markdown, JSON, etc. For complex formats (docx),
 * requires external tools.
 */
function processDocument(filePath: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const ext = path.extname(filePath).toLowerCase();

  try {
    // For simple text formats, just read directly
    if (['.txt', '.md', '.csv', '.json', '.xml', '.html'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const truncated = content.length > 50000 ? content.slice(0, 50000) + '\n\n[... truncated]' : content;

      blocks.push({
        type: 'text',
        text: `[Document: ${path.basename(filePath)}]\n\n${truncated}`,
      });
    } else if (ext === '.docx') {
      // Try to extract text from docx using python-docx or unzip
      const unzipCheck = spawnSync('which', ['unzip'], { encoding: 'utf-8' });
      if (unzipCheck.status === 0) {
        const tempDir = path.join(path.dirname(filePath), '.docx-extract');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        // Extract document.xml from the docx (it's a zip file)
        const extractResult = spawnSync('unzip', [
          '-p',
          filePath,
          'word/document.xml',
        ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

        if (extractResult.status === 0 && extractResult.stdout) {
          // Simple XML text extraction (strip tags)
          const text = extractResult.stdout
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n\n[... truncated]' : text;
          blocks.push({
            type: 'text',
            text: `[Document: ${path.basename(filePath)}]\n\n${truncated}`,
          });
        } else {
          blocks.push({
            type: 'text',
            text: `[Document: ${path.basename(filePath)} - docx extraction failed]`,
          });
        }

        try {
          fs.rmdirSync(tempDir);
        } catch {
          // Not empty
        }
      } else {
        blocks.push({
          type: 'text',
          text: `[Document: ${path.basename(filePath)} - docx extraction not available (unzip not found)]`,
        });
      }
    } else {
      // Unknown document format
      blocks.push({
        type: 'text',
        text: `[Document: ${path.basename(filePath)} - format not supported for text extraction]`,
      });
    }
  } catch (err) {
    blocks.push({
      type: 'text',
      text: `[Document processing error: ${err instanceof Error ? err.message : String(err)}]`,
    });
  }

  return blocks;
}

/**
 * Process an audio file - provide metadata and transcription placeholder.
 * Actual transcription would require Whisper API or similar.
 */
function processAudio(filePath: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Check if ffprobe is available for metadata
  const ffprobeCheck = spawnSync('which', ['ffprobe'], { encoding: 'utf-8' });
  if (ffprobeCheck.status === 0) {
    try {
      const probeResult = spawnSync('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        filePath,
      ], { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });

      if (probeResult.status === 0 && probeResult.stdout) {
        const metadata = JSON.parse(probeResult.stdout);
        const duration = parseFloat(metadata.format?.duration || '0');

        blocks.push({
          type: 'text',
          text: `[Audio: ${path.basename(filePath)}, Duration: ${duration.toFixed(1)}s - transcription not available]`,
        });
      }
    } catch (err) {
      blocks.push({
        type: 'text',
        text: `[Audio: ${path.basename(filePath)} - metadata extraction failed]`,
      });
    }
  } else {
    blocks.push({
      type: 'text',
      text: `[Audio file: ${path.basename(filePath)}]`,
    });
  }

  return blocks;
}

/**
 * Process a single file and return structured content blocks.
 */
export function processFile(filePath: string): ProcessedFile {
  const filename = path.basename(filePath);
  let stats: fs.Stats;

  try {
    stats = fs.statSync(filePath);
  } catch (err) {
    return {
      originalPath: filePath,
      type: 'unknown',
      blocks: [],
      metadata: {
        filename,
        size: 0,
        mimeType: 'application/octet-stream',
        error: `File not found: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const { category, mimeType } = getFileTypeInfo(filePath);

  let blocks: ContentBlock[] = [];
  let error: string | undefined;

  try {
    switch (category) {
      case 'image':
        blocks = processImage(filePath, mimeType);
        log(`Processed image: ${filename}`);
        break;
      case 'video':
        blocks = processVideo(filePath);
        log(`Processed video: ${filename}`);
        break;
      case 'pdf':
        blocks = processPDF(filePath);
        log(`Processed PDF: ${filename}`);
        break;
      case 'document':
        blocks = processDocument(filePath);
        log(`Processed document: ${filename}`);
        break;
      case 'audio':
        blocks = processAudio(filePath);
        log(`Processed audio: ${filename}`);
        break;
      default:
        blocks = [{
          type: 'text',
          text: `[File: ${filename} - type not supported for processing]`,
        }];
        log(`Unknown file type: ${filename}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    blocks = [{
      type: 'text',
      text: `[File: ${filename} - processing failed: ${error}]`,
    }];
    log(`Processing error for ${filename}: ${error}`);
  }

  return {
    originalPath: filePath,
    type: category,
    blocks,
    metadata: {
      filename,
      size: stats.size,
      mimeType,
      error,
    },
  };
}

/**
 * Parse attachment annotations from formatted message text.
 * Returns array of file paths found in the message.
 */
export function extractAttachmentPaths(text: string): string[] {
  const attachmentRegex = /\[(?:image|video|audio|document|file):\s*[^\]]*—\s*saved to\s+([^\]]+)\]/gi;
  const paths: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = attachmentRegex.exec(text)) !== null) {
    paths.push(match[1].trim());
  }

  return paths;
}

/**
 * Remove attachment annotations from text.
 */
export function stripAttachmentAnnotations(text: string): string {
  return text.replace(/\[(?:image|video|audio|document|file):\s*[^\]]*—\s*saved to\s+[^\]]+\]/gi, '').trim();
}

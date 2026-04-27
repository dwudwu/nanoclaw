/**
 * MCP tools for managing file attachments.
 *
 * Provides agents with the ability to:
 * - List all attachments in the workspace
 * - Get detailed information about specific files
 * - Re-process files with different options
 * - Clean up old attachments
 */
import fs from 'fs';
import path from 'path';
import type { ToolHandler } from './types.js';
import { processFile } from '../file-processor.js';
import { registerTools } from './server.js';

const ATTACHMENTS_DIR = '/workspace/attachments';

interface AttachmentInfo {
  filename: string;
  path: string;
  size: number;
  type: string;
  mimeType: string;
  created: string;
}

/**
 * List all attachments in the workspace.
 */
export const listAttachments: ToolHandler = {
  definition: {
    name: 'mcp__nanoclaw__list_attachments',
    description: 'List all file attachments in the workspace. Returns filename, size, type, and creation time for each file.',
    inputSchema: {
      type: 'object',
      properties: {
        type_filter: {
          type: 'string',
          description: 'Optional filter by file type: "image", "video", "pdf", "document", "audio", or "all"',
          enum: ['image', 'video', 'pdf', 'document', 'audio', 'all'],
        },
        sort_by: {
          type: 'string',
          description: 'Sort results by: "name", "size", or "date"',
          enum: ['name', 'size', 'date'],
        },
      },
    },
  },
  async handler(args) {
    const typeFilter = (args.type_filter as string) || 'all';
    const sortBy = (args.sort_by as string) || 'date';

    if (!fs.existsSync(ATTACHMENTS_DIR)) {
      return {
        content: [{ type: 'text', text: 'No attachments directory found. No files have been uploaded yet.' }],
      };
    }

    const files = fs.readdirSync(ATTACHMENTS_DIR);
    const attachments: AttachmentInfo[] = [];

    for (const filename of files) {
      // Skip hidden files and temp directories
      if (filename.startsWith('.')) continue;

      const filePath = path.join(ATTACHMENTS_DIR, filename);
      const stats = fs.statSync(filePath);

      if (!stats.isFile()) continue;

      const result = processFile(filePath);

      // Apply type filter
      if (typeFilter !== 'all' && result.type !== typeFilter) {
        continue;
      }

      attachments.push({
        filename,
        path: filePath,
        size: stats.size,
        type: result.type,
        mimeType: result.metadata.mimeType,
        created: stats.birthtime.toISOString(),
      });
    }

    // Sort
    if (sortBy === 'name') {
      attachments.sort((a, b) => a.filename.localeCompare(b.filename));
    } else if (sortBy === 'size') {
      attachments.sort((a, b) => b.size - a.size);
    } else {
      // date (newest first)
      attachments.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    }

    if (attachments.length === 0) {
      return {
        content: [{ type: 'text', text: `No attachments found${typeFilter !== 'all' ? ` of type "${typeFilter}"` : ''}.` }],
      };
    }

    // Format output
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const lines = [
      `Found ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}:`,
      '',
    ];

    for (const att of attachments) {
      const date = new Date(att.created).toLocaleDateString();
      lines.push(`• ${att.filename} (${att.type}, ${formatSize(att.size)}, ${date})`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
};

/**
 * Get detailed information about a specific attachment.
 */
export const getAttachmentInfo: ToolHandler = {
  definition: {
    name: 'mcp__nanoclaw__get_attachment_info',
    description: 'Get detailed information about a specific attachment file, including metadata and content preview.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Name of the attachment file',
        },
        include_content: {
          type: 'boolean',
          description: 'Whether to include the processed content blocks (images, text extraction, etc.)',
        },
      },
      required: ['filename'],
    },
  },
  async handler(args) {
    const filename = args.filename as string;
    const includeContent = (args.include_content as boolean) ?? false;
    const filePath = path.join(ATTACHMENTS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: 'text', text: `Attachment "${filename}" not found.` }],
        isError: true,
      };
    }

    const stats = fs.statSync(filePath);
    const result = processFile(filePath);

    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const info = [
      `File: ${filename}`,
      `Type: ${result.type}`,
      `MIME Type: ${result.metadata.mimeType}`,
      `Size: ${formatSize(stats.size)}`,
      `Created: ${stats.birthtime.toLocaleString()}`,
      `Modified: ${stats.mtime.toLocaleString()}`,
      `Path: ${filePath}`,
    ];

    if (result.metadata.error) {
      info.push(`Error: ${result.metadata.error}`);
    }

    if (includeContent && result.blocks.length > 0) {
      info.push('', 'Content:');
      // Return the full content blocks
      return {
        content: [
          { type: 'text', text: info.join('\n') },
          ...result.blocks,
        ],
      };
    }

    return {
      content: [{ type: 'text', text: info.join('\n') }],
    };
  },
};

/**
 * Delete old attachments to free up space.
 */
export const cleanupAttachments: ToolHandler = {
  definition: {
    name: 'mcp__nanoclaw__cleanup_attachments',
    description: 'Delete old attachment files to free up disk space. Can delete by age or by file type.',
    inputSchema: {
      type: 'object',
      properties: {
        days_old: {
          type: 'number',
          description: 'Delete files older than this many days (default: 30)',
        },
        type_filter: {
          type: 'string',
          description: 'Optional filter by file type to delete only specific types',
          enum: ['image', 'video', 'pdf', 'document', 'audio', 'all'],
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, show what would be deleted without actually deleting',
        },
      },
    },
  },
  async handler(args) {
    const daysOld = (args.days_old as number) ?? 30;
    const typeFilter = (args.type_filter as string) || 'all';
    const dryRun = (args.dry_run as boolean) ?? true;

    if (!fs.existsSync(ATTACHMENTS_DIR)) {
      return {
        content: [{ type: 'text', text: 'No attachments directory found.' }],
      };
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const files = fs.readdirSync(ATTACHMENTS_DIR);
    const toDelete: string[] = [];
    let totalSize = 0;

    for (const filename of files) {
      if (filename.startsWith('.')) continue;

      const filePath = path.join(ATTACHMENTS_DIR, filename);
      const stats = fs.statSync(filePath);

      if (!stats.isFile()) continue;
      if (stats.birthtime > cutoffDate) continue;

      const result = processFile(filePath);

      if (typeFilter !== 'all' && result.type !== typeFilter) {
        continue;
      }

      toDelete.push(filename);
      totalSize += stats.size;
    }

    if (toDelete.length === 0) {
      return {
        content: [{ type: 'text', text: `No files found older than ${daysOld} days${typeFilter !== 'all' ? ` of type "${typeFilter}"` : ''}.` }],
      };
    }

    const formatSize = (bytes: number): string => {
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    if (dryRun) {
      const preview = [
        `Would delete ${toDelete.length} file(s) (${formatSize(totalSize)}):`,
        '',
        ...toDelete.map((f) => `• ${f}`),
        '',
        'Run with dry_run=false to actually delete these files.',
      ];
      return {
        content: [{ type: 'text', text: preview.join('\n') }],
      };
    }

    // Actually delete
    let deleted = 0;
    for (const filename of toDelete) {
      try {
        fs.unlinkSync(path.join(ATTACHMENTS_DIR, filename));
        deleted++;
      } catch (err) {
        console.error(`Failed to delete ${filename}: ${err}`);
      }
    }

    return {
      content: [{ type: 'text', text: `Deleted ${deleted} file(s) (${formatSize(totalSize)}).` }],
    };
  },
};

// Register attachment management tools
registerTools([listAttachments, getAttachmentInfo, cleanupAttachments]);

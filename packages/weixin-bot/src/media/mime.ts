/**
 * MIME type mapping for Weixin media sending.
 * Ported from OpenClaw openclaw-weixin extension.
 */
import { extname } from 'node:path';

const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.silk': 'audio/silk',
  '.slk': 'audio/silk',
  '.amr': 'audio/amr',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Get MIME type from filename extension. Returns "application/octet-stream" for unknown. */
export function getMimeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}
